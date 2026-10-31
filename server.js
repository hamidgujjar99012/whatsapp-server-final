const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const cron = require('node-cron');
const admin = require('firebase-admin');
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

// ---------- Firebase (Bot account) ----------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
  });
}
const db = admin.firestore();

// ---------- Session folder (Railway Volume yahan mount karo: /app/sessions) ----------
const SESSIONS_ROOT = '/app/sessions';
if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

const sessions = {}; // har ISP ka alag WhatsApp connection yahan store hoga

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

  const sock = makeWASocket({ version, auth: state, browser: ['VIDEO ZONE', 'Chrome', '1.0.0'] });
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
      await db.collection('isps').doc(ispId).set({ whatsappConnected: true }, { merge: true });
    }

    if (connection === 'close') {
      sessions[ispId].connecting = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const badSession = code === DisconnectReason.badSession;

      await db.collection('isps').doc(ispId).set({ whatsappConnected: false }, { merge: true });

      if (loggedOut || badSession) {
        // Purani kharab session apne aap delete ho jayegi, next baar fresh QR milega
        clearSessionFolder(ispId);
        sessions[ispId].status = 'disconnected';
        sessions[ispId].qr = null;
      } else {
        startSocketForIsp(ispId); // thoda sa net issue tha, dobara try karo
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

// ---------- Reset button (agar atak jaye to isko call karo) ----------
app.post('/api/whatsapp/reset/:ispId', async (req, res) => {
  const { ispId } = req.params;
  try {
    if (sessions[ispId]?.sock) try { sessions[ispId].sock.end(undefined); } catch (_) {}
    delete sessions[ispId];
    clearSessionFolder(ispId);
    await startSocketForIsp(ispId, { forceFresh: true });
    res.json({ message: 'Reset ho gaya, naya QR tayar ho raha hai' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Phone number ko sahi format mein badalna ----------
function normalizePhoneToJid(rawPhone, defaultCountryCode = '92') { // Pakistan = 92, India = 91
  let digits = rawPhone.replace(/\D/g, '');
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
    const custSnap = await db.collection('isps').doc(ispId).collection('customers').doc(customerId).get();
    if (!custSnap.exists) return res.status(404).json({ error: 'Customer nahi mila' });
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

// ---------- Auto Reminder: 4 din pehle ----------
cron.schedule('0 10 * * *', async () => { // roz subah 10 baje check karega
  const ispsSnap = await db.collection('isps').get();
  for (const ispDoc of ispsSnap.docs) {
    const ispId = ispDoc.id;
    if (sessions[ispId]?.status !== 'connected') continue;

    const fourDaysLater = Date.now() + 4 * 24 * 60 * 60 * 1000;
    const customersSnap = await db.collection('isps').doc(ispId).collection('customers')
      .where('expiryDate', '<=', fourDaysLater)
      .where('expiryDate', '>=', Date.now())
      .get();

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
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Server chal raha hai port', PORT));
