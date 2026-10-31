const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const cron = require('node-cron');
const pino = require('pino');
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, collection, doc, getDoc, getDocs, query, where, setDoc } = require('firebase/firestore');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ---------- Firebase (Bot account se login) ----------
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

async function ensureBotLogin() {
  try {
    await signInWithEmailAndPassword(auth, process.env.BOT_EMAIL, process.env.BOT_PASSWORD);
    console.log('Bot account se Firebase login ho gaya ✅');
  } catch (err) {
    console.error('Bot login fail:', err.message);
  }
}
ensureBotLogin();
// Firebase token kabhi kabhi expire ho jata hai, is liye har 50 minute mein dobara login karwao
setInterval(ensureBotLogin, 50 * 60 * 1000);

// ---------- Session folder (Railway Volume: /app/sessions) ----------
const SESSIONS_ROOT = '/app/sessions';
if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

const sessions = {};
const logger = pino({ level: 'silent' }); // Baileys ke andaruni logs chup rakhne ke liye

function getSessionDir(ispId) {
  return path.join(SESSIONS_ROOT, ispId);
}
function clearSessionFolder(ispId) {
  const dir = getSessionDir(ispId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function startSocketForIsp(ispId, { forceFresh = false } = {}) {
  if (sessions[ispId]?.connecting) return;
  if (forceFresh) clearSessionFolder(ispId);

  sessions[ispId] = { ...(sessions[ispId] || {}), connecting: true, status: 'connecting', qr: null };

  const { state, saveCreds } = await useMultiFileAuthState(getSessionDir(ispId));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['VIDEO ZONE', 'Chrome', '1.0.0'],
  });
  sessions[ispId].sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessions[ispId].qr = qr;
      sessions[ispId].status = 'qr';
      console.log(`[${ispId}] Naya QR ban gaya ✅`);
    }

    if (connection === 'open') {
      sessions[ispId].status = 'connected';
      sessions[ispId].qr = null;
      sessions[ispId].connecting = false;
      console.log(`[${ispId}] WhatsApp connect ho gaya 🎉`);
      try {
        await setDoc(doc(db, 'isps', ispId), { whatsappConnected: true }, { merge: true });
      } catch (e) { console.error('Firestore update fail:', e.message); }
    }

    if (connection === 'close') {
      sessions[ispId].connecting = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const badSession = code === DisconnectReason.badSession;

      try {
        await setDoc(doc(db, 'isps', ispId), { whatsappConnected: false }, { merge: true });
      } catch (e) {}

      if (loggedOut || badSession) {
        clearSessionFolder(ispId);
        sessions[ispId].status = 'disconnected';
        sessions[ispId].qr = null;
        console.log(`[${ispId}] Purani session saaf kar di, naya QR agli baar milega`);
      } else {
        startSocketForIsp(ispId);
      }
    }
  });
}

// ---------- Status check ----------
app.get('/api/whatsapp/status/:ispId', (req, res) => {
  const s = sessions[req.params.ispId];
  res.json({ connected: s?.status === 'connected', status: s?.status || 'disconnected' });
});

// ---------- QR laane wala endpoint ----------
app.get('/api/whatsapp/qr/:ispId', async (req, res) => {
  const { ispId } = req.params;
  try {
    if (!sessions[ispId] || sessions[ispId].status === 'disconnected') {
      await startSocketForIsp(ispId);
    }
    for (let i = 0; i < 20; i++) {
      if (sessions[ispId]?.status === 'connected') return res.json({ connected: true });
      if (sessions[ispId]?.qr) {
        const qrImage = await QRCode.toDataURL(sessions[ispId].qr);
        return res.json({ connected: false, qr: qrImage });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    res.status(504).json({ error: 'QR nahi bana, reset button try karein' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Reset endpoint ----------
app.post('/api/whatsapp/reset/:ispId', async (req, res) => {
  const { ispId } = req.params;
  try {
    if (sessions[ispId]?.sock) { try { sessions[ispId].sock.end(undefined); } catch (_) {} }
    delete sessions[ispId];
    clearSessionFolder(ispId);
    await startSocketForIsp(ispId, { forceFresh: true });
    res.json({ message: 'Reset ho gaya, naya QR tayar ho raha hai' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Phone number normalize ----------
function normalizePhoneToJid(rawPhone, defaultCountryCode = '92') {
  let digits = String(rawPhone).replace(/\D/g, '');
  digits = digits.replace(/^0+/, '');
  if (digits.length === 10) digits = defaultCountryCode + digits;
  return `${digits}@s.whatsapp.net`;
}

async function sendWhatsAppMessage(ispId, rawPhone, message) {
  const sock = sessions[ispId]?.sock;
  if (!sock || sessions[ispId].status !== 'connected') throw new Error('WhatsApp connected nahi hai');

  const jid = normalizePhoneToJid(rawPhone);
  const [check] = await sock.onWhatsApp(jid);
  if (!check?.exists) throw new Error('Ye number WhatsApp par nahi hai: ' + rawPhone);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sock.sendMessage(check.jid, { text: message });
      return true;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------- "Mark as Paid" => Auto Receipt ----------
app.post('/api/whatsapp/send-receipt', async (req, res) => {
  const { ispId, customerId, amount, planName, paidDate } = req.body;
  try {
    const custRef = doc(db, 'isps', ispId, 'customers', customerId);
    const custSnap = await getDoc(custRef);
    if (!custSnap.exists()) return res.status(404).json({ error: 'Customer nahi mila' });
    const c = custSnap.data();

    const msg =
`✅ *Payment Mil Gayi*
Hi ${c.name}, aapki payment receive ho gayi hai.

Plan: ${planName}
Amount: Rs. ${amount}
Date: ${paidDate}

Shukriya - VIDEO ZONE 🙌`;

    await sendWhatsAppMessage(ispId, c.phone, msg);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Auto Reminder: 4 din pehle, roz subah 10 baje ----------
cron.schedule('0 10 * * *', async () => {
  console.log('Reminder check chal raha hai...');
  try {
    const ispsSnap = await getDocs(collection(db, 'isps'));
    for (const ispDoc of ispsSnap.docs) {
      const ispId = ispDoc.id;
      if (sessions[ispId]?.status !== 'connected') continue;

      const fourDaysLater = Date.now() + 4 * 24 * 60 * 60 * 1000;
      const custQuery = query(
        collection(db, 'isps', ispId, 'customers'),
        where('expiryDate', '<=', fourDaysLater),
        where('expiryDate', '>=', Date.now())
      );
      const customersSnap = await getDocs(custQuery);

      for (const custDoc of customersSnap.docs) {
        const c = custDoc.data();
        try {
          await sendWhatsAppMessage(ispId, c.phone,
            `⏰ Hi ${c.name}, aapka VIDEO ZONE plan (${c.planName}) 4 din mein expire ho raha hai. Waqt par renew kar lein warna connection band ho jayega.`);
        } catch (err) {
          console.log('Reminder fail:', c.phone, err.message);
        }
      }
    }
  } catch (err) {
    console.error('Cron job error:', err.message);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Server chal raha hai port', PORT));
