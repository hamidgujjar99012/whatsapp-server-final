const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, collection, getDocs } = require('firebase/firestore');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

// --- FIREBASE CONFIG ---
const firebaseConfig = {
  apiKey: "AIzaSyAbOSA-JI8yrJDJBScsiQxnohWOLowyGTY",
  authDomain: "quick-layout-pmn89.firebaseapp.com",
  projectId: "quick-layout-pmn89",
  storageBucket: "quick-layout-pmn89.firebasestorage.app",
  messagingSenderId: "111040364657",
  appId: "1:111040364657:web:570feb58b15db4ea9d9bd0"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp); 

async function loginBot() {
    try {
        await signInWithEmailAndPassword(auth, "BOT_EMAIL_YAHAN_DALEIN", "BOT_PASSWORD_YAHAN_DALEIN");
        console.log("🤖 Bot successfully logged into Firebase!");
    } catch (error) {
        console.error("❌ Bot login failed:", error.message);
    }
}
loginBot();

// --- EXPRESS SETUP ---
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const sessions = new Map();

async function connectToWhatsApp(ispId) {
    if (sessions.has(ispId) && sessions.get(ispId).isConnected) return sessions.get(ispId).sock;
    const sessionDir = path.join(__dirname, 'sessions', ispId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });

    sessions.set(ispId, { sock, isConnected: false, qr: null });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) sessions.get(ispId).qr = await qrcode.toDataURL(qr);
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            sessions.get(ispId).isConnected = false;
            if (shouldReconnect) setTimeout(() => connectToWhatsApp(ispId), 3000);
            else { fs.rmSync(sessionDir, { recursive: true, force: true }); sessions.delete(ispId); }
        } else if (connection === 'open') {
            sessions.get(ispId).isConnected = true;
            sessions.get(ispId).qr = null;
        }
    });
    sock.ev.on('creds.update', saveCreds);
    return sock;
}

// --- API ROUTES ---
app.get('/api/whatsapp/qr/:ispId', async (req, res) => {
    const { ispId } = req.params;
    if (sessions.has(ispId) && sessions.get(ispId).isConnected) return res.json({ status: 'connected' });
    if (!sessions.has(ispId)) { await connectToWhatsApp(ispId); await new Promise(r => setTimeout(r, 2000)); }
    const session = sessions.get(ispId);
    res.json(session?.qr ? { status: 'qr', qr: session.qr } : { status: 'initializing' });
});

app.get('/api/whatsapp/status/:ispId', (req, res) => {
    res.json({ connected: sessions.get(req.params.ispId)?.isConnected || false });
});

app.post('/api/whatsapp/send', async (req, res) => {
    const { ispId, phone, message, imageBase64 } = req.body;
    if (!sessions.has(ispId) || !sessions.get(ispId).isConnected) return res.status(400).json({ error: 'Not connected' });
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '92' + cleanPhone.slice(1);
    const jid = `${cleanPhone}@s.whatsapp.net`;
    try {
        if (imageBase64) await sessions.get(ispId).sock.sendMessage(jid, { image: Buffer.from(imageBase64.split(',')[1], 'base64'), caption: message });
        else await sessions.get(ispId).sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Send fail' }); }
});

// Naya Disconnect Route (Ban hone par kaam aayega)
app.post('/api/whatsapp/disconnect/:ispId', async (req, res) => {
    const { ispId } = req.params;
    if (sessions.has(ispId)) {
        const session = sessions.get(ispId);
        try { await session.sock.logout(); } catch (e) {}
        const sessionDir = path.join(__dirname, 'sessions', ispId);
        try { if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        sessions.delete(ispId);
        return res.json({ success: true, message: 'Disconnected successfully' });
    }
    res.json({ success: true, message: 'Already disconnected' });
});

// --- CRON JOB (3-Day Reminders) ---
cron.schedule('0 10 * * *', async () => {
    if (!auth.currentUser) await loginBot();
    try {
        const targetDate = new Date(); targetDate.setDate(targetDate.getDate() + 3);
        const targetStr = targetDate.toISOString().slice(0, 10);
        const snap = await getDocs(collection(db, 'customers'));
        for (const doc of snap.docs) {
            const c = doc.data();
            if (c.expiryDate === targetStr && (c.status === 'Active' || c.paymentStatus === 'Unpaid')) {
                const isp = c.operator_id;
                if (sessions.has(isp) && sessions.get(isp).isConnected) {
                    let p = c.phone.replace(/\D/g, '');
                    if (p.startsWith('0')) p = '92' + p.slice(1);
                    await sessions.get(isp).sock.sendMessage(`${p}@s.whatsapp.net`, { text: `Dear ${c.fullName}, your package expires on ${c.expiryDate}. Please pay Rs. ${c.outstandingBalance || c.monthlyFee}.` });
                }
            }
        }
    } catch (err) { console.error(err); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server 24/7 Mode par chal raha hai. Port: ${PORT}`);
});
