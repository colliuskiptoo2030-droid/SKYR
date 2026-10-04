require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets directly from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Route 1: Serve Main Game Page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route 2: Serve Admin Radar Page
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// In-Memory Balance Storage
const userBalances = {};

const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'SUPER_SECRET_ADMIN_KEY';

// ==========================================
// 1. MEGAPAY M-PESA API ENDPOINTS
// ==========================================

// Initiate M-Pesa STK Push via MegaPay
app.post('/api/mpesa/stkpush', async (req, res) => {
    try {
        const { phone, amount, userId } = req.body;

        if (!phone || !amount) {
            return res.status(400).json({ error: "Phone number and amount are required." });
        }

        // Format phone number to 2547XXXXXXXX or 2541XXXXXXXX format
        let formattedPhone = phone.toString().trim().replace('+', '');
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '254' + formattedPhone.slice(1);
        } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
            formattedPhone = '254' + formattedPhone;
        }

        console.log(`⏳ Requesting MegaPay STK Push for ${formattedPhone}...`);

        const payload = {
            api_key: process.env.MEGAPAY_API_KEY,
            email: process.env.MEGAPAY_EMAIL,
            amount: Math.round(Number(amount)),
            msisdn: formattedPhone,
            reference: userId || `USER_${formattedPhone}`
        };

        const response = await fetch('https://megapay.co.ke/backend/v1/initiatestk', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const rawText = await response.text();
        console.log("RAW MEGAPAY RESPONSE:", rawText);

        let data;
        try {
            data = JSON.parse(rawText);
        } catch (parseErr) {
            console.error("Non-JSON response received from MegaPay:", rawText);
            return res.status(502).json({
                error: "MegaPay server returned an HTML error or invalid response.",
                raw: rawText.substring(0, 200)
            });
        }

        if (data.status === 'success' || data.ResponseCode === 0 || data.ResponseCode === "0") {
            return res.status(200).json({
                success: true,
                message: "STK Push prompt sent to your phone.",
                data: data
            });
        } else {
            return res.status(400).json({
                error: data.message || data.massage || data.ResponseDescription || "STK Push request failed."
            });
        }

    } catch (error) {
        console.error("MegaPay STK Push Error:", error.message || error);
        res.status(500).json({
            error: "Failed to initiate STK Push via MegaPay.",
            details: error.message || error
        });
    }
});

// WITHDRAWAL ENDPOINT
app.post('/api/mpesa/withdraw', (req, res) => {
    const { phone, amount } = req.body;

    if (!phone || !amount) {
        return res.status(400).json({ error: "Phone number and amount are required." });
    }

    const withdrawAmount = Number(amount);
    const currentBalance = userBalances[phone] || 0;

    if (currentBalance < withdrawAmount) {
        return res.status(400).json({ error: "Insufficient balance for withdrawal." });
    }

    userBalances[phone] -= withdrawAmount;

    console.log(`⏳ Withdrawal requested: Phone ${phone}, Amount KES ${withdrawAmount}`);

    res.status(200).json({
        success: true,
        message: "Withdrawal request submitted successfully.",
        newBalance: userBalances[phone]
    });

    setTimeout(() => {
        const fakeReceipt = 'WS' + Math.random().toString(36).substring(2, 10).toUpperCase();
        console.log(`✅ Withdrawal Processed: KES ${withdrawAmount} sent to ${phone} (Ref: ${fakeReceipt})`);

        io.emit('withdraw_success', {
            phone,
            amount: withdrawAmount,
            receipt: fakeReceipt,
            newBalance: userBalances[phone]
        });
    }, 3000);
});

// MegaPay Webhook Listener
app.post('/api/mpesa/callback', (req, res) => {
    console.log("--- MEGAPAY WEBHOOK RECEIVED ---");
    console.log(JSON.stringify(req.body, null, 2));

    const payload = req.body;

    if (payload.ResponseCode === 0 || payload.status === 'success') {
        const amount = Number(payload.TransactionAmount || payload.amount);
        const receipt = payload.TransactionReceipt || payload.checkout_id;
        const phone = payload.Msisdn || payload.phone || payload.sender_phone_number;

        console.log(`✅ Payment Received via MegaPay! Phone: ${phone}, Amount: KES ${amount}, Receipt: ${receipt}`);

        if (phone) {
            userBalances[phone] = (userBalances[phone] || 0) + amount;
            io.emit('deposit_success', { phone, amount, receipt, newBalance: userBalances[phone] });
        }
    } else {
        console.log(`⚠️ Transaction status failed or cancelled: ${payload.ResponseDescription || 'Unknown Status'}`);
    }

    res.status(200).send('OK');
});

// ==========================================
// 2. SKYRUSH GAME ENGINE (SOCKET.IO)
// ==========================================
let multiplier = 1.00;
let isCrashed = false;
let gameInterval = null;
let roundId = 0;

function startNewGameRound() {
    multiplier = 1.00;
    isCrashed = false;
    roundId++;
    
    const crashPoint = parseFloat((Math.random() * (70 - 1.05) + 1.05).toFixed(2));
    console.log(`🎮 New Round #${roundId} Started. Will crash at: ${crashPoint}x`);

    io.emit('game_start', { multiplier: 1.00, roundId });

    io.to('admin_room').emit('admin_next_crash', {
        roundId,
        nextCrash: crashPoint
    });

    gameInterval = setInterval(() => {
        if (multiplier >= crashPoint) {
            isCrashed = true;
            clearInterval(gameInterval);
            console.log(`💥 CRASHED at ${multiplier.toFixed(2)}x`);
            io.emit('game_crash', { multiplier: multiplier.toFixed(2) });

            setTimeout(startNewGameRound, 5000);
        } else {
            multiplier += 0.03;
            io.emit('multiplier_update', { multiplier: multiplier.toFixed(2) });
        }
    }, 150);
}

startNewGameRound();

// Socket Connections
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    socket.on('join_admin', (secretKey) => {
        if (secretKey === ADMIN_SECRET_KEY) {
            socket.join('admin_room');
            socket.emit('admin_auth_success', 'Authenticated as Admin');
            console.log(`🔒 Admin joined radar room: ${socket.id}`);
        } else {
            socket.emit('admin_auth_failed', 'Invalid secret key');
            console.log(`⚠️ Admin auth failed for: ${socket.id}`);
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ Client disconnected: ${socket.id}`);
    });
});

// ==========================================
// 3. SERVER BINDING
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Skyrush Game Server running on port ${PORT}`);
});
