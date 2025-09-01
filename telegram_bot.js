const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Konfigurasi dari environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID ? parseInt(process.env.OWNER_ID) : null;

// Validasi konfigurasi
if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN tidak ditemukan di file .env');
    process.exit(1);
}

if (!OWNER_ID) {
    console.error('❌ OWNER_ID tidak ditemukan di file .env');
    process.exit(1);
}

// Inisialisasi bot Telegram
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Tracking active processes
const activeProcesses = new Map(); // userId -> processInfo
const autoJoinSessions = new Map(); // userId -> autojoin session info

// Admin management functions
function loadAdmins() {
    try {
        if (fs.existsSync('admin.json')) {
            const data = fs.readFileSync('admin.json', 'utf8');
            const parsed = JSON.parse(data);
            return parsed.admins || [];
        }
    } catch (error) {
        console.error('Error loading admin.json:', error);
    }
    return [];
}

function saveAdmins(admins) {
    try {
        const data = {
            admins: admins,
            lastUpdated: new Date().toISOString()
        };
        fs.writeFileSync('admin.json', JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving admin.json:', error);
        return false;
    }
}

// Initialize admin.json if it doesn't exist
function initializeAdminFile() {
    if (!fs.existsSync('admin.json')) {
        const initialAdmins = [OWNER_ID]; // Owner is always an admin
        saveAdmins(initialAdmins);
        console.log('✅ admin.json created with owner as initial admin');
    }
}

// Utility functions
function isOwner(userId) {
    return userId === OWNER_ID;
}

function isAdmin(userId) {
    const admins = loadAdmins();
    return admins.includes(userId);
}

function validatePhoneNumber(phoneNumber) {
    // Remove all non-digit characters
    const cleanNumber = phoneNumber.replace(/\D/g, '');
    
    // Check if it's a valid international format (at least 10 digits, starts with country code)
    if (cleanNumber.length < 10 || cleanNumber.length > 15) {
        return { valid: false, error: 'Nomor telepon harus 10-15 digit' };
    }
    
    // Common country code patterns
    const validPrefixes = ['62', '60', '65', '1', '44', '49', '33', '39', '34', '91', '86', '81', '82'];
    const hasValidPrefix = validPrefixes.some(prefix => cleanNumber.startsWith(prefix));
    
    if (!hasValidPrefix) {
        return { valid: false, error: 'Format nomor tidak valid. Gunakan format internasional (contoh: 628123456789)' };
    }
    
    return { valid: true, number: cleanNumber };
}

function getUserInfo(msg) {
    return {
        id: msg.from.id,
        username: msg.from.username || 'N/A',
        firstName: msg.from.first_name || 'N/A',
        lastName: msg.from.last_name || 'N/A'
    };
}

async function logActivity(action, userInfo, details = '') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${action} - User: ${userInfo.firstName} (@${userInfo.username}, ID: ${userInfo.id}) ${details}\n`;
    
    try {
        await fs.promises.appendFile('telegram_bot.log', logEntry);
    } catch (error) {
        console.error('Error writing to log:', error);
    }
}

// AutoJoin specific functions
function extractGroupId(link) {
    const regex = /https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/;
    const match = link.match(regex);
    return match ? match[1] : null;
}

function saveAutoJoinLinks(userId, phoneNumber, links) {
    const filePath = `autojoin_links_${phoneNumber}_${userId}.json`;
    const data = {
        links: links,
        last_updated: new Date().toISOString(),
        phone_number: phoneNumber,
        telegram_chat_id: userId
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadAutoJoinLinks(userId, phoneNumber) {
    const filePath = `autojoin_links_${phoneNumber}_${userId}.json`;
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading autojoin links:', error);
    }
    return { links: [], last_updated: null };
}

function createStartJoinCommand(userId, phoneNumber) {
    const commandFile = `autojoin_command_${phoneNumber}_${userId}.txt`;
    fs.writeFileSync(commandFile, 'startjoin');
}

// Clean up session files and folder
function cleanupAutoJoinSession(userId, phoneNumber) {
    const filesToClean = [
        `autojoin_links_${phoneNumber}_${userId}.json`,
        `autojoin_command_${phoneNumber}_${userId}.txt`
    ];
    
    // Clean up files
    filesToClean.forEach(file => {
        if (fs.existsSync(file)) {
            try {
                fs.unlinkSync(file);
                console.log(`Cleaned up file: ${file}`);
            } catch (e) {
                console.error(`Error deleting ${file}:`, e);
            }
        }
    });
    
    // Clean up auth directory
    const authDir = `autojoin_auth_${phoneNumber}`;
    if (fs.existsSync(authDir)) {
        try {
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log(`Cleaned up auth directory: ${authDir}`);
        } catch (e) {
            console.error('Error cleaning auth directory:', e);
        }
    }
}

// Initialize admin file on startup
initializeAdminFile();

// Command handlers
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    await logActivity('START_COMMAND', userInfo);
    
    let roleInfo = '';
    if (isOwner(userInfo.id)) {
        roleInfo = '👑 Anda adalah owner dan dapat menggunakan semua fitur.';
    } else if (isAdmin(userInfo.id)) {
        roleInfo = '✅ Anda adalah admin dan dapat menggunakan fitur ekstraksi.';
    } else {
        roleInfo = '❌ Anda bukan admin. Akses terbatas.';
    }
    
    const welcomeMessage = `
🤖 *IGIMONSAN BOT*

Selamat datang! Bot ini dapat membantu Anda mengekstrak dan join grup WhatsApp secara otomatis.

📋 *Perintah yang tersedia:*
• \`/extract [nomor_wa]\` - Ekstrak grup WhatsApp
• \`/autojoin [nomor_wa]\` - Auto join grup WhatsApp
• \`/status\` - Cek status proses
• \`/cancel\` - Batalkan proses aktif
• \`/help\` - Bantuan penggunaan

${isOwner(userInfo.id) ? `
👑 *Perintah Owner:*
• \`/addadmin [user_id]\` - Tambah admin baru
• \`/removeadmin [user_id]\` - Hapus admin
• \`/showadmin\` - Lihat semua admin
` : ''}

📱 *Format nomor WhatsApp:*
• Indonesia: 628123456789
• Malaysia: 60123456789
• Singapura: 6512345678

⚡ *Contoh penggunaan:*
\`/extract 628123456789\`
\`/autojoin 628123456789\`

${roleInfo}

🆕 *Update v2.4.1:*
• Perbaikan sistem pelaporan autojoin
• Pembersihan session yang lebih baik
• Laporan hasil dalam format TXT
• Perbaikan bug session tidak tertutup
    `;
    
    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    await logActivity('HELP_COMMAND', userInfo);
    
    const ownerCommands = isOwner(userInfo.id) ? `

👑 *Perintah Owner:*
\`/addadmin [user_id]\` - Menambahkan admin baru ke sistem
\`/removeadmin [user_id]\` - Menghapus admin dari sistem
\`/showadmin\` - Melihat daftar semua admin yang aktif

📸 *Manajemen Admin:*
• Hanya owner yang dapat mengelola admin
• Admin disimpan di file admin.json
• Owner selalu menjadi admin otomatis
• Owner tidak dapat dihapus dari sistem
` : '';
    
    const helpMessage = `
📚 *Bantuan Penggunaan Bot v2.4.1*

📸 *Perintah Utama:*
\`/extract [nomor_wa]\` - Memulai proses ekstraksi grup WhatsApp
\`/autojoin [nomor_wa]\` - Memulai proses auto join grup WhatsApp

📸 *AutoJoin Commands:*
\`/addlinks\` - Tambah link grup untuk autojoin (saat session aktif)
\`/join\` - Mulai proses join ke semua grup (saat session aktif)

📸 *Perintah Lain:*
• \`/status\` - Cek apakah ada proses yang berjalan
• \`/cancel\` - Batalkan proses yang sedang berjalan
• \`/logs\` - Lihat log aktivitas (admin only)
${ownerCommands}

🔄 *Alur AutoJoin:*
1. \`/autojoin [nomor_wa]\` - Mulai session
2. Masukkan pairing code di WhatsApp
3. \`/addlinks\` - Kirim link grup yang ingin dijoin
4. \`/join\` - Konfirmasi dan mulai join semua grup

⚠️ *Catatan Penting:*
• Gunakan nomor WhatsApp Anda sendiri
• Proses dapat memakan waktu 2-5 menit
• Pastikan WhatsApp aktif di ponsel saat proses berjalan
• Hasil akan berupa file TXT dengan link yang berhasil dijoin
    `;
    
    await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/autojoin(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    const phoneNumber = match[1];
    
    await logActivity('AUTOJOIN_COMMAND', userInfo, `Phone: ${phoneNumber || 'not provided'}`);
    
    // Check if user is admin
    if (!isAdmin(userInfo.id)) {
        await bot.sendMessage(chatId, '❌ Maaf, hanya admin yang dapat menggunakan fitur ini.');
        return;
    }
    
    // Check if phone number is provided
    if (!phoneNumber) {
        await bot.sendMessage(chatId, `
❌ *Format perintah salah!*

Gunakan format: \`/autojoin [nomor_wa]\`

📱 *Contoh:*
\`/autojoin 628123456789\` (Indonesia)
\`/autojoin 60123456789\` (Malaysia)
\`/autojoin 6512345678\` (Singapura)

💡 *Tips:*
• Gunakan nomor WhatsApp Anda sendiri
• Format internasional tanpa tanda + atau spasi
• Pastikan nomor aktif dan terhubung dengan WhatsApp
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Validate phone number
    const phoneValidation = validatePhoneNumber(phoneNumber);
    if (!phoneValidation.valid) {
        await bot.sendMessage(chatId, `❌ ${phoneValidation.error}`);
        return;
    }
    
    // Check if user already has active autojoin session
    if (autoJoinSessions.has(userInfo.id)) {
        const session = autoJoinSessions.get(userInfo.id);
        await bot.sendMessage(chatId, `
⚠️ Anda sudah memiliki session autojoin yang aktif!

📱 Nomor aktif: ${session.phoneNumber}
📊 Link tersimpan: ${session.links ? session.links.length : 0}

Gunakan \`/addlinks\` untuk menambah link grup atau \`/join\` untuk memulai join.
Atau gunakan \`/cancel\` untuk membatalkan session ini.
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Check if user has active extraction process
    if (activeProcesses.has(userInfo.id)) {
        await bot.sendMessage(chatId, `
⚠️ Anda sudah memiliki proses ekstraksi yang sedang berjalan!

Gunakan \`/cancel\` untuk membatalkan proses ekstraksi terlebih dahulu.
        `);
        return;
    }
    
    // Start autojoin process
    await startAutoJoinProcess(chatId, userInfo, phoneValidation.number);
});

bot.onText(/\/addlinks/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    await logActivity('ADDLINKS_COMMAND', userInfo);
    
    // Check if user has active autojoin session
    if (!autoJoinSessions.has(userInfo.id)) {
        await bot.sendMessage(chatId, `
❌ *Tidak ada session autojoin yang aktif!*

Mulai session autojoin terlebih dahulu dengan:
\`/autojoin [nomor_wa]\`

Contoh: \`/autojoin 628123456789\`
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    const session = autoJoinSessions.get(userInfo.id);
    
    if (session.stage !== 'connected') {
        await bot.sendMessage(chatId, `
⚠️ *Session belum siap untuk menerima link!*

📊 Status saat ini: ${session.stage}

Tunggu hingga WhatsApp berhasil terhubung, lalu coba lagi.
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    await bot.sendMessage(chatId, `
📝 *Kirim Link Grup WhatsApp*

📱 Session aktif: ${session.phoneNumber}
📊 Link tersimpan: ${session.links ? session.links.length : 0}

💡 *Cara mengirim link:*
• Kirim 1 link per pesan atau beberapa sekaligus
• Bot akan otomatis mendeteksi dan menyimpan link
• Anda bisa mengirim link kapan saja selama session aktif

🔗 *Format link yang diterima:*
https://chat.whatsapp.com/GZqg8bpwGla5M9fbJnrm79
https://chat.whatsapp.com/ABC123xyz?mode=ems_copy_c

Setelah selesai mengirim semua link, gunakan \`/join\` untuk memulai proses join.
    `, { parse_mode: 'Markdown' });
    
    // Update session stage to waiting for links
    session.stage = 'waiting_links';
    autoJoinSessions.set(userInfo.id, session);
});

bot.onText(/\/join/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    await logActivity('STARTJOIN_COMMAND', userInfo);
    
    // Check if user has active autojoin session
    if (!autoJoinSessions.has(userInfo.id)) {
        await bot.sendMessage(chatId, `
❌ *Tidak ada session autojoin yang aktif!*

Mulai session autojoin terlebih dahulu dengan:
\`/autojoin [nomor_wa]\`
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    const session = autoJoinSessions.get(userInfo.id);
    
    if (!session.links || session.links.length === 0) {
        await bot.sendMessage(chatId, `
❌ *Belum ada link grup yang disimpan!*

Gunakan \`/addlinks\` untuk menambahkan link grup terlebih dahulu.

📝 Atau langsung kirim link grup WhatsApp ke chat ini.
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Show confirmation
    await bot.sendMessage(chatId, `
🏯 *Konfirmasi Auto Join*

📱 Nomor: ${session.phoneNumber}
📊 Total link grup: ${session.links.length}

📋 *Link yang akan dijoin:*
${session.links.slice(0, 10).map((link, i) => `${i + 1}. ${link}`).join('\n')}
${session.links.length > 10 ? `\n... dan ${session.links.length - 10} link lainnya` : ''}

⚠️ *Peringatan:*
• Proses ini akan join SEMUA grup dalam daftar
• Tidak dapat dibatalkan setelah dimulai
• Estimasi waktu: ${Math.ceil(session.links.length * 1.5)} detik

Ketik \`/confirm\` untuk melanjutkan atau \`/cancel\` untuk membatalkan.
    `, { parse_mode: 'Markdown' });
    
    session.stage = 'confirm_join';
    autoJoinSessions.set(userInfo.id, session);
});

bot.onText(/\/confirm/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    await logActivity('CONFIRM_COMMAND', userInfo);
    
    // Check if user has active autojoin session in confirm stage
    if (!autoJoinSessions.has(userInfo.id)) {
        await bot.sendMessage(chatId, '❌ Tidak ada session yang menunggu konfirmasi.');
        return;
    }
    
    const session = autoJoinSessions.get(userInfo.id);
    
    if (session.stage !== 'confirm_join') {
        await bot.sendMessage(chatId, '❌ Session tidak dalam tahap konfirmasi.');
        return;
    }
    
    // Start the actual join process
    await startJoinProcess(chatId, userInfo, session);
});

async function startAutoJoinProcess(chatId, userInfo, phoneNumber) {
    const sessionInfo = {
        phoneNumber,
        startTime: Date.now(),
        stage: 'initializing',
        links: [],
        chatId: chatId // Store chat ID for later use
    };
    
    await bot.sendMessage(chatId, `
🚀 *Memulai AutoJoin WhatsApp*

📱 Nomor: ${phoneNumber}
⏱️ Estimasi waktu: 2-5 menit

📞 Sedang mempersiapkan WhatsApp Web...

💡 *Pastikan:*
• WhatsApp aktif di ponsel dengan nomor ${phoneNumber}
• Koneksi internet stabil
• Jangan tutup WhatsApp selama proses
    `, { parse_mode: 'Markdown' });
    
    try {
        // Spawn the autojoin process
        const autoJoinProcess = spawn('node', ['autojoin.js', phoneNumber, chatId.toString()], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false
        });
        
        sessionInfo.process = autoJoinProcess;
        sessionInfo.stage = 'connecting';
        autoJoinSessions.set(userInfo.id, sessionInfo);
        
        let outputBuffer = '';
        let errorBuffer = '';
        let pairingCodeSent = false;
        
        // Handle stdout
        autoJoinProcess.stdout.on('data', async (data) => {
            const output = data.toString();
            outputBuffer += output;
            
            console.log(`[AUTOJOIN-${userInfo.id}-${phoneNumber}] STDOUT:`, output);
            
            // Check for pairing code
            if (output.includes('KODE PAIRING ANDA:') && !pairingCodeSent) {
                const codeMatch = output.match(/KODE PAIRING ANDA:\s*(\w+)/);
                if (codeMatch) {
                    const pairingCode = codeMatch[1];
                    pairingCodeSent = true;
                    
                    sessionInfo.stage = 'waiting_pairing';
                    
                    await bot.sendMessage(chatId, `
🔑 *Kode Pairing WhatsApp*

📱 **${pairingCode}**

📱 *Langkah-langkah pairing:*
1. Buka WhatsApp di ponsel dengan nomor **${phoneNumber}**
2. Tap Menu (⋮) → Perangkat Tertaut
3. Tap "Tautkan Perangkat"
4. Tap "Tautkan dengan nomor telepon"
5. Masukkan kode: **${pairingCode}**

⏳ Menunggu konfirmasi pairing untuk nomor ${phoneNumber}...

⚠️ *Penting:* Pastikan Anda menggunakan WhatsApp dengan nomor yang sama!
                    `, { parse_mode: 'Markdown' });
                }
            }
            
            // Check for successful connection
            if (output.includes('Login berhasil')) {
                sessionInfo.stage = 'connected';
                autoJoinSessions.set(userInfo.id, sessionInfo);
                
                await bot.sendMessage(chatId, `
✅ *WhatsApp Berhasil Terhubung!*

📱 Nomor ${phoneNumber} telah terhubung
🏯 Session autojoin siap digunakan

📝 *Langkah selanjutnya:*
• Gunakan \`/addlinks\` untuk menambah link grup
• Atau langsung kirim link grup WhatsApp ke chat ini
• Setelah selesai, gunakan \`/join\` untuk memulai join

💡 *Tips:*
• Anda bisa mengirim banyak link sekaligus
• Link akan otomatis tersimpan dan divalidasi
• Session akan aktif selama 30 menit
                `, { parse_mode: 'Markdown' });
            }
        });
        
        // Handle stderr
        autoJoinProcess.stderr.on('data', (data) => {
            const error = data.toString();
            errorBuffer += error;
            console.error(`[AUTOJOIN-${userInfo.id}-${phoneNumber}] STDERR:`, error);
        });
        
        // Handle process completion
        autoJoinProcess.on('close', async (code) => {
            console.log(`[AUTOJOIN-${userInfo.id}-${phoneNumber}] Process exited with code:`, code);
            
            if (code === 0) {
                // Process completed successfully, but don't clean up session yet
                // Wait for results to be processed first
                await bot.sendMessage(chatId, `
✅ *Proses AutoJoin Selesai!*

📱 Nomor: ${phoneNumber}
🏯 Semua grup telah diproses

📊 Sedang mempersiapkan laporan hasil...
                `, { parse_mode: 'Markdown' });
            } else {
                // Process failed, clean up session
                autoJoinSessions.delete(userInfo.id);
                cleanupAutoJoinSession(userInfo.id, phoneNumber);
                
                await bot.sendMessage(chatId, `
❌ *Proses AutoJoin Gagal*

📱 Nomor: ${phoneNumber}
💥 Terjadi kesalahan saat proses autojoin.

**Kemungkinan penyebab:**
• Kode pairing salah atau expired
• Nomor WhatsApp tidak sesuai atau tidak aktif
• Koneksi internet bermasalah
• Session timeout

💡 **Solusi:**
• Pastikan menggunakan nomor WhatsApp yang benar
• Coba lagi dengan \`/autojoin ${phoneNumber}\`
• Pastikan WhatsApp aktif di ponsel
                `, { parse_mode: 'Markdown' });
            }
            
            await logActivity('AUTOJOIN_COMPLETED', userInfo, `Phone: ${phoneNumber}, Code: ${code}`);
        });
        
        // Handle process error
        autoJoinProcess.on('error', async (error) => {
            console.error(`[AUTOJOIN-${userInfo.id}-${phoneNumber}] Process error:`, error);
            
            autoJoinSessions.delete(userInfo.id);
            cleanupAutoJoinSession(userInfo.id, phoneNumber);
            
            await bot.sendMessage(chatId, `
❌ *Kesalahan Sistem*

Terjadi kesalahan saat memulai proses autojoin.

💡 Silakan coba lagi dengan \`/autojoin ${phoneNumber}\`
            `, { parse_mode: 'Markdown' });
            
            await logActivity('AUTOJOIN_ERROR', userInfo, `Phone: ${phoneNumber}, Error: ${error.message}`);
        });
        
        // Set timeout for session (30 minutes)
        setTimeout(async () => {
            if (autoJoinSessions.has(userInfo.id)) {
                const session = autoJoinSessions.get(userInfo.id);
                try {
                    if (session.process) {
                        session.process.kill('SIGTERM');
                    }
                    autoJoinSessions.delete(userInfo.id);
                    cleanupAutoJoinSession(userInfo.id, phoneNumber);
                    
                    await bot.sendMessage(chatId, `
⏰ *Session AutoJoin Timeout*

📱 Nomor: ${phoneNumber}
⏱️ Waktu: 30 menit (maximum)

Session dihentikan karena melebihi batas waktu maksimum.

💡 Silakan mulai session baru dengan \`/autojoin ${phoneNumber}\`
                    `, { parse_mode: 'Markdown' });
                    
                    await logActivity('AUTOJOIN_TIMEOUT', userInfo, `Phone: ${phoneNumber}`);
                } catch (error) {
                    console.error('Error killing timed out autojoin session:', error);
                }
            }
        }, 30 * 60 * 1000); // 30 minutes
        
    } catch (error) {
        console.error('Error starting autojoin process:', error);
        autoJoinSessions.delete(userInfo.id);
        
        await bot.sendMessage(chatId, `
❌ *Gagal Memulai AutoJoin*

Terjadi kesalahan saat memulai proses untuk nomor ${phoneNumber}.

💡 Silakan coba lagi dengan \`/autojoin ${phoneNumber}\`
        `, { parse_mode: 'Markdown' });
        
        await logActivity('AUTOJOIN_START_ERROR', userInfo, `Phone: ${phoneNumber}, Error: ${error.message}`);
    }
}

async function startJoinProcess(chatId, userInfo, session) {
    try {
        // Save links to file that autojoin.js can read
        saveAutoJoinLinks(userInfo.id, session.phoneNumber, session.links);
        
        // Create command file for autojoin.js to start joining
        createStartJoinCommand(userInfo.id, session.phoneNumber);
        
        session.stage = 'joining';
        autoJoinSessions.set(userInfo.id, session);
        
        await bot.sendMessage(chatId, `
🏯 *Memulai Proses Join Grup*

📱 Nomor: ${session.phoneNumber}
📊 Total grup: ${session.links.length}
⏱️ Estimasi waktu: ${Math.ceil(session.links.length * 1.5)} detik

🚀 Sedang join grup satu per satu...

💡 Proses akan berjalan otomatis dengan delay 0-1 detik per grup untuk menghindari spam detection.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('JOIN_PROCESS_STARTED', userInfo, `Phone: ${session.phoneNumber}, Links: ${session.links.length}`);
        
    } catch (error) {
        console.error('Error starting join process:', error);
        await bot.sendMessage(chatId, '❌ Gagal memulai proses join. Silakan coba lagi.');
    }
}

// Monitor autojoin log file for results - UPDATED VERSION
setInterval(async () => {
    try {
        const logFile = 'autojoin_log.txt';
        if (fs.existsSync(logFile)) {
            const logContent = fs.readFileSync(logFile, 'utf8');
            const lines = logContent.trim().split('\n').filter(line => line);
            
            for (const line of lines) {
                try {
                    const logEntry = JSON.parse(line);
                    
                    // Find the corresponding user session
                    let targetUserId = null;
                    let targetSession = null;
                    for (const [userId, session] of autoJoinSessions) {
                        if (session.phoneNumber === logEntry.phone && 
                            session.chatId === parseInt(logEntry.chat_id)) {
                            targetUserId = userId;
                            targetSession = session;
                            break;
                        }
                    }
                    
                    if (!targetUserId || !targetSession) continue;
                    
                    const chatId = parseInt(logEntry.chat_id);
                    
                    if (logEntry.type === 'result' || logEntry.type === 'completed') {
                        // Process completed, send final results and THEN cleanup session
                        console.log(`Processing autojoin results for user ${targetUserId}, phone ${logEntry.phone}`);
                        
                        // Send results first before cleaning up session
                        await sendJoinResults(chatId, logEntry.phone, targetUserId, targetSession);
                        
                        // IMPORTANT: Clean up session AFTER sending results
                        autoJoinSessions.delete(targetUserId);
                        cleanupAutoJoinSession(targetUserId, logEntry.phone);
                        
                        console.log(`Session cleaned up for user ${targetUserId}, phone ${logEntry.phone}`);
                    }
                } catch (parseError) {
                    console.error('Error parsing log entry:', parseError);
                }
            }
            
            // Clear the log file after processing
            fs.writeFileSync(logFile, '');
        }
    } catch (error) {
        console.error('Error monitoring autojoin log:', error);
    }
}, 3000); // Check every 3 seconds

async function sendJoinResults(chatId, phoneNumber, userId, session) {
    try {
        console.log(`Sending join results for phone ${phoneNumber}, user ${userId}`);
        
        // Look for result files
        const files = fs.readdirSync('.');
        const reportFiles = files.filter(f => f.startsWith(`autojoin_final_report_${phoneNumber}_`)).sort((a, b) => {
            const statsA = fs.statSync(a);
            const statsB = fs.statSync(b);
            return statsB.mtime - statsA.mtime; // Most recent first
        });
        
        let successful = [];
        let alreadyMember = [];
        let failed = [];
        let totalProcessed = 0;
        
        if (reportFiles.length > 0) {
            const latestReportFile = reportFiles[0];
            console.log(`Found report file: ${latestReportFile}`);
            
            try {
                // Read report data
                const reportData = JSON.parse(fs.readFileSync(latestReportFile, 'utf8'));
                const results = reportData.results || [];
                
                // Categorize results
                successful = results.filter(r => r.status === 'success');
                alreadyMember = results.filter(r => r.status === 'already_member');
                failed = results.filter(r => r.status !== 'success' && r.status !== 'already_member');
                totalProcessed = results.length;
                
                console.log(`Results: Success=${successful.length}, Already=${alreadyMember.length}, Failed=${failed.length}`);
                
                // Send summary message first
                await bot.sendMessage(chatId, `
🏆 *AutoJoin Selesai!*

📱 **Nomor:** ${phoneNumber}
📊 **Hasil Join:**

✅ **Berhasil join:** ${successful.length} grup
👥 **Sudah member:** ${alreadyMember.length} grup
❌ **Gagal join:** ${failed.length} grup
📊 **Total diproses:** ${totalProcessed} grup

⏱️ **Selesai pada:** ${new Date().toLocaleString('id-ID')}

📄 Mengirim laporan hasil...
                `, { parse_mode: 'Markdown' });
                
                // Create and send TXT file with successful links only
                if (successful.length > 0) {
                    const successfulLinks = successful.map(r => r.link).join('\n');
                    const txtFileName = `autojoin_success_${phoneNumber}_${userId}_${Date.now()}.txt`;
                    
                    fs.writeFileSync(txtFileName, successfulLinks);
                    console.log(`Created TXT file: ${txtFileName} with ${successful.length} successful links`);
                    
                    await bot.sendDocument(chatId, txtFileName, {
                        caption: `📄 **Link Grup yang Berhasil Dijoin**\n\n✅ ${successful.length} grup berhasil dijoin\n📱 Nomor: ${phoneNumber}`
                    });
                    
                    console.log(`TXT file sent successfully to chat ${chatId}`);
                    
                    // Cleanup txt file after sending
                    setTimeout(() => {
                        try {
                            if (fs.existsSync(txtFileName)) {
                                fs.unlinkSync(txtFileName);
                                console.log(`Cleaned up TXT file: ${txtFileName}`);
                            }
                        } catch (e) {
                            console.error('Error deleting txt file:', e);
                        }
                    }, 10000); // 10 seconds delay
                } else {
                    await bot.sendMessage(chatId, `
📄 **Tidak ada grup yang berhasil dijoin**

❌ Semua ${totalProcessed} grup gagal dijoin atau sudah menjadi member.

**Kemungkinan penyebab:**
• Link grup sudah expired atau tidak valid
• Grup sudah private atau tidak menerima member baru
• Anda sudah menjadi member di semua grup
• Rate limit dari WhatsApp

💡 Coba gunakan link grup yang lebih baru dan pastikan masih aktif.
                    `, { parse_mode: 'Markdown' });
                }
                
                // Also send JSON report for detailed info
                await bot.sendDocument(chatId, latestReportFile, {
                    caption: `📋 **Laporan Detail AutoJoin**\n\n📱 Nomor: ${phoneNumber}\n📊 Total: ${totalProcessed} grup\n🕐 ${new Date().toLocaleString('id-ID')}`
                });
                
                // Cleanup report file after sending
                setTimeout(() => {
                    try {
                        if (fs.existsSync(latestReportFile)) {
                            fs.unlinkSync(latestReportFile);
                            console.log(`Cleaned up report file: ${latestReportFile}`);
                        }
                    } catch (e) {
                        console.error('Error deleting report file:', e);
                    }
                }, 15000); // 15 seconds delay
                
            } catch (fileError) {
                console.error('Error reading report file:', fileError);
                await bot.sendMessage(chatId, `
❌ **Error membaca laporan hasil**

📱 Nomor: ${phoneNumber}
💥 Terjadi kesalahan saat membaca file laporan.

Proses mungkin sudah selesai tetapi laporan tidak dapat dibaca.
                `, { parse_mode: 'Markdown' });
            }
        } else {
            console.log(`No report files found for phone ${phoneNumber}`);
            await bot.sendMessage(chatId, `
⚠️ **File laporan tidak ditemukan**

📱 Nomor: ${phoneNumber}
📊 Proses mungkin belum selesai sepenuhnya atau terjadi kesalahan.

💡 Gunakan \`/status\` untuk cek status atau coba lagi dengan \`/autojoin ${phoneNumber}\`
            `, { parse_mode: 'Markdown' });
        }
        
        // Send final completion message
        await bot.sendMessage(chatId, `
🎯 **AutoJoin Session Ditutup**

📱 **Nomor:** ${phoneNumber}
📊 **Statistik Final:**
✅ Berhasil join: **${successful.length}** grup
👥 Sudah member: **${alreadyMember.length}** grup  
❌ Gagal join: **${failed.length}** grup

🗂️ **File yang dikirim:**
${successful.length > 0 ? '• Daftar link berhasil (TXT)' : '• Tidak ada link berhasil'}
• Laporan detail (JSON)

🔒 **Keamanan:** Session WhatsApp telah dihapus otomatis.

💡 Gunakan \`/autojoin [nomor]\` untuk session baru.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('AUTOJOIN_RESULTS_SENT', { id: userId }, `Phone: ${phoneNumber}, Success: ${successful.length}, Total: ${totalProcessed}`);
        
    } catch (error) {
        console.error('Error sending join results:', error);
        
        // Still cleanup session even if sending results failed
        autoJoinSessions.delete(userId);
        cleanupAutoJoinSession(userId, phoneNumber);
        
        await bot.sendMessage(chatId, `
❌ **Kesalahan mengirim laporan**

📱 Nomor: ${phoneNumber}
💥 Terjadi kesalahan saat mengirim hasil.

🔒 Session telah ditutup untuk keamanan.
💡 Silakan coba lagi dengan \`/autojoin ${phoneNumber}\`
        `, { parse_mode: 'Markdown' });
    }
}

// Handle incoming messages for link detection during autojoin session
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    // Skip if it's a command
    if (msg.text && msg.text.startsWith('/')) {
        return;
    }
    
    // Check if user has active autojoin session waiting for links
    if (autoJoinSessions.has(userInfo.id)) {
        const session = autoJoinSessions.get(userInfo.id);
        
        if (session.stage === 'connected' || session.stage === 'waiting_links') {
            const messageText = msg.text || '';
            
            // Extract WhatsApp group links from message
            const linkRegex = /https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+(?:\?[^\s]*)?/g;
            const foundLinks = messageText.match(linkRegex) || [];
            
            if (foundLinks.length > 0) {
                // Clean links (remove query parameters for processing but keep original for joining)
                const cleanedLinks = foundLinks.map(link => {
                    // Keep original link but validate the group ID part
                    const groupId = extractGroupId(link);
                    return groupId ? link : null;
                }).filter(Boolean);
                
                if (cleanedLinks.length > 0) {
                    // Add to session links (avoid duplicates)
                    if (!session.links) session.links = [];
                    
                    const newLinks = cleanedLinks.filter(link => !session.links.includes(link));
                    session.links.push(...newLinks);
                    
                    autoJoinSessions.set(userInfo.id, session);
                    
                    // Save to file
                    saveAutoJoinLinks(userInfo.id, session.phoneNumber, session.links);
                    
                    await bot.sendMessage(chatId, `
✅ *Link Grup Berhasil Ditambahkan*

📊 **Link baru:** ${newLinks.length}
📊 **Total link:** ${session.links.length}
📱 **Session:** ${session.phoneNumber}

💡 *Link yang ditambahkan:*
${newLinks.slice(0, 5).map((link, i) => `${i + 1}. ${link.substring(0, 50)}...`).join('\n')}
${newLinks.length > 5 ? `\n... dan ${newLinks.length - 5} link lainnya` : ''}

📝 **Lanjutkan:**
• Kirim lebih banyak link grup, atau
• Gunakan \`/join\` untuk mulai join semua grup

⏳ Session aktif hingga ${new Date(session.startTime + 30 * 60 * 1000).toLocaleString('id-ID')}
                    `, { parse_mode: 'Markdown' });
                    
                    await logActivity('LINKS_ADDED', userInfo, `Phone: ${session.phoneNumber}, New: ${newLinks.length}, Total: ${session.links.length}`);
                } else {
                    await bot.sendMessage(chatId, '❌ Link grup tidak valid atau sudah ada dalam daftar.');
                }
            }
        }
    }
});

bot.onText(/\/addadmin(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    const targetUserId = match[1] ? parseInt(match[1]) : null;
    
    await logActivity('ADDADMIN_COMMAND', userInfo, `Target: ${targetUserId || 'not provided'}`);
    
    // Check if user is owner
    if (!isOwner(userInfo.id)) {
        await bot.sendMessage(chatId, '❌ Hanya owner yang dapat menambahkan admin baru.');
        return;
    }
    
    // Check if target user ID is provided
    if (!targetUserId) {
        await bot.sendMessage(chatId, `
❌ *Format perintah salah!*

Gunakan format: \`/addadmin [user_id]\`

🔢 *Contoh:*
\`/addadmin 123456789\`

💡 *Tips:*
• User ID adalah nomor ID unik Telegram
• User bisa mendapatkan ID mereka dengan mengirim pesan ke bot @userinfobot
• Pastikan ID yang dimasukkan benar
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Check if target is owner
    if (targetUserId === OWNER_ID) {
        await bot.sendMessage(chatId, '❌ Owner sudah otomatis menjadi admin.');
        return;
    }
    
    // Load current admins
    const currentAdmins = loadAdmins();
    
    // Check if user is already admin
    if (currentAdmins.includes(targetUserId)) {
        await bot.sendMessage(chatId, `❌ User ID ${targetUserId} sudah menjadi admin.`);
        return;
    }
    
    // Add new admin
    const newAdmins = [...currentAdmins, targetUserId];
    
    if (saveAdmins(newAdmins)) {
        await bot.sendMessage(chatId, `
✅ *Admin Berhasil Ditambahkan!*

👤 **User ID:** ${targetUserId}
📊 **Total admin sekarang:** ${newAdmins.length + 1} (termasuk owner)

💡 Admin baru dapat langsung menggunakan fitur ekstraksi.

Gunakan \`/showadmin\` untuk melihat semua admin.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('ADMIN_ADDED', userInfo, `New admin: ${targetUserId}`);
        
        // Try to notify the new admin (optional, might fail if they haven't started the bot)
        try {
            await bot.sendMessage(targetUserId, `
🏆 *Anda telah ditambahkan sebagai admin!*

✅ Anda sekarang dapat menggunakan fitur ekstraksi grup WhatsApp.

📋 Gunakan \`/help\` untuk melihat perintah yang tersedia.

Mulai dengan \`/extract [nomor_wa]\` untuk mengekstrak grup.
            `, { parse_mode: 'Markdown' });
        } catch (error) {
            // User hasn't started the bot yet, ignore error
            console.log(`Could not notify new admin ${targetUserId}: ${error.message}`);
        }
    } else {
        await bot.sendMessage(chatId, '❌ Gagal menyimpan admin baru. Silakan coba lagi.');
    }
});

bot.onText(/\/showadmin/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    await logActivity('SHOWADMIN_COMMAND', userInfo);
    
    // Check if user is owner
    if (!isOwner(userInfo.id)) {
        await bot.sendMessage(chatId, '❌ Hanya owner yang dapat melihat daftar admin.');
        return;
    }
    
    const admins = loadAdmins();
    
    let adminList = `👑 **Owner:** ${OWNER_ID}\n\n`;
    
    if (admins.length > 0) {
        adminList += `✅ **Admin List:**\n`;
        admins.forEach((adminId, index) => {
            if (adminId !== OWNER_ID) { // Don't show owner twice
                adminList += `${index + 1}. ${adminId}\n`;
            }
        });
    } else {
        adminList += `📝 **Admin List:** Kosong (hanya owner)`;
    }
    
    const totalAdmins = admins.filter(id => id !== OWNER_ID).length;
    
    await bot.sendMessage(chatId, `
👥 *Daftar Admin Bot*

${adminList}

📊 **Statistik:**
• Total admin: ${totalAdmins}
• Total pengguna authorized: ${totalAdmins + 1} (termasuk owner)

💡 Gunakan \`/addadmin [user_id]\` untuk menambah admin baru.
💡 Gunakan \`/removeadmin [user_id]\` untuk menghapus admin.

🕐 **Last updated:** ${new Date().toLocaleString('id-ID')}
    `, { parse_mode: 'Markdown' });
});

bot.onText(/\/removeadmin(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    const targetUserId = match[1] ? parseInt(match[1]) : null;
    
    await logActivity('REMOVEADMIN_COMMAND', userInfo, `Target: ${targetUserId || 'not provided'}`);
    
    // Check if user is owner
    if (!isOwner(userInfo.id)) {
        await bot.sendMessage(chatId, '❌ Hanya owner yang dapat menghapus admin.');
        return;
    }
    
    // Check if target user ID is provided
    if (!targetUserId) {
        await bot.sendMessage(chatId, `
❌ *Format perintah salah!*

Gunakan format: \`/removeadmin [user_id]\`

🔢 *Contoh:*
\`/removeadmin 123456789\`

💡 *Tips:*
• Masukkan User ID yang ingin dihapus dari admin
• Gunakan \`/showadmin\` untuk melihat daftar admin
• Owner tidak dapat dihapus dari sistem
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Check if trying to remove owner
    if (targetUserId === OWNER_ID) {
        await bot.sendMessage(chatId, '❌ Owner tidak dapat dihapus dari sistem admin.');
        return;
    }
    
    // Load current admins
    const currentAdmins = loadAdmins();
    
    // Check if user is actually an admin
    if (!currentAdmins.includes(targetUserId)) {
        await bot.sendMessage(chatId, `❌ User ID ${targetUserId} bukan admin atau tidak ditemukan.`);
        return;
    }
    
    // Remove admin
    const newAdmins = currentAdmins.filter(id => id !== targetUserId);
    
    if (saveAdmins(newAdmins)) {
        await bot.sendMessage(chatId, `
✅ *Admin Berhasil Dihapus!*

👤 **User ID yang dihapus:** ${targetUserId}
📊 **Total admin sekarang:** ${newAdmins.filter(id => id !== OWNER_ID).length} (tidak termasuk owner)

💡 User ini tidak dapat lagi menggunakan fitur ekstraksi.

Gunakan \`/showadmin\` untuk melihat admin yang tersisa.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('ADMIN_REMOVED', userInfo, `Removed admin: ${targetUserId}`);
        
        // Try to notify the removed admin (optional, might fail if they haven't started the bot)
        try {
            await bot.sendMessage(targetUserId, `
⚠️ *Status Admin Dicabut*

❌ Anda telah dihapus dari daftar admin bot.

🔒 Anda tidak dapat lagi menggunakan fitur ekstraksi grup WhatsApp.

💡 Hubungi owner jika ada kesalahan atau untuk mendapatkan akses kembali.
            `, { parse_mode: 'Markdown' });
        } catch (error) {
            // User might have blocked bot or not started it, ignore error
            console.log(`Could not notify removed admin ${targetUserId}: ${error.message}`);
        }
    } else {
        await bot.sendMessage(chatId, '❌ Gagal menghapus admin. Silakan coba lagi.');
    }
});

bot.onText(/\/extract(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    const phoneNumber = match[1];
    
    await logActivity('EXTRACT_COMMAND', userInfo, `Phone: ${phoneNumber || 'not provided'}`);
    
    // Check if user is admin
    if (!isAdmin(userInfo.id)) {
        await bot.sendMessage(chatId, '❌ Maaf, hanya admin yang dapat menggunakan fitur ini.');
        return;
    }
    
    // Check if phone number is provided
    if (!phoneNumber) {
        await bot.sendMessage(chatId, `
❌ *Format perintah salah!*

Gunakan format: \`/extract [nomor_wa]\`

📱 *Contoh:*
\`/extract 628123456789\` (Indonesia)
\`/extract 60123456789\` (Malaysia)
\`/extract 6512345678\` (Singapura)

💡 *Tips:*
• Gunakan nomor WhatsApp Anda sendiri
• Format internasional tanpa tanda + atau spasi
• Pastikan nomor aktif dan terhubung dengan WhatsApp
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Validate phone number
    const phoneValidation = validatePhoneNumber(phoneNumber);
    if (!phoneValidation.valid) {
        await bot.sendMessage(chatId, `❌ ${phoneValidation.error}`);
        return;
    }
    
    // Check if user already has active process
    if (activeProcesses.has(userInfo.id)) {
        await bot.sendMessage(chatId, `
⚠️ Anda sudah memiliki proses yang sedang berjalan!

📱 Nomor aktif: ${activeProcesses.get(userInfo.id).phoneNumber}

Gunakan \`/status\` untuk melihat status atau \`/cancel\` untuk membatalkan.
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Check if user has active autojoin session
    if (autoJoinSessions.has(userInfo.id)) {
        await bot.sendMessage(chatId, `
⚠️ Anda sudah memiliki session autojoin yang aktif!

Gunakan \`/cancel\` untuk membatalkan session autojoin terlebih dahulu.
        `);
        return;
    }
    
    // Start extraction process
    await startExtractionProcess(chatId, userInfo, phoneValidation.number);
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    await logActivity('STATUS_COMMAND', userInfo);
    
    let statusMessage = '';
    
    // Check extraction process
    if (activeProcesses.has(userInfo.id)) {
        const processInfo = activeProcesses.get(userInfo.id);
        const duration = Math.floor((Date.now() - processInfo.startTime) / 1000);
        
        statusMessage += `
📊 *Status Ekstraksi*

📞 Status: Sedang berjalan
📱 Nomor: ${processInfo.phoneNumber}
⏱️ Durasi: ${duration} detik
🏯 Tahap: ${processInfo.stage || 'Inisialisasi'}

⏳ Silakan tunggu proses selesai...
        `;
    }
    
    // Check autojoin session
    if (autoJoinSessions.has(userInfo.id)) {
        const session = autoJoinSessions.get(userInfo.id);
        const duration = Math.floor((Date.now() - session.startTime) / 1000);
        
        statusMessage += `
🤖 *Status AutoJoin*

📞 Status: ${session.stage}
📱 Nomor: ${session.phoneNumber}
⏱️ Durasi: ${duration} detik
📊 Link tersimpan: ${session.links ? session.links.length : 0}

${session.stage === 'connected' || session.stage === 'waiting_links' ? 
  '💡 Gunakan `/addlinks` untuk menambah link atau langsung kirim link grup.' : 
  '⏳ Silakan tunggu proses selesai...'}
        `;
    }
    
    if (!statusMessage) {
        statusMessage = '✅ Tidak ada proses yang sedang berjalan.\n\n• Gunakan `/extract [nomor_wa]` untuk ekstraksi grup\n• Gunakan `/autojoin [nomor_wa]` untuk auto join grup';
    }
    
    await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    await logActivity('CANCEL_COMMAND', userInfo);
    
    if (!isAdmin(userInfo.id)) {
        await bot.sendMessage(chatId, '❌ Hanya admin yang dapat membatalkan proses.');
        return;
    }
    
    let cancelled = false;
    
    // Cancel extraction process
    if (activeProcesses.has(userInfo.id)) {
        const processInfo = activeProcesses.get(userInfo.id);
        
        try {
            processInfo.process.kill('SIGTERM');
            activeProcesses.delete(userInfo.id);
            cancelled = true;
            
            await bot.sendMessage(chatId, `
✅ *Proses Ekstraksi Dibatalkan*

📱 Nomor: ${processInfo.phoneNumber}
⏱️ Durasi sebelum dibatalkan: ${Math.floor((Date.now() - processInfo.startTime) / 1000)} detik
            `, { parse_mode: 'Markdown' });
            
            await logActivity('EXTRACTION_CANCELLED', userInfo, `Phone: ${processInfo.phoneNumber}`);
        } catch (error) {
            await bot.sendMessage(chatId, '❌ Gagal membatalkan proses ekstraksi.');
            console.error('Error cancelling extraction process:', error);
        }
    }
    
    // Cancel autojoin session
    if (autoJoinSessions.has(userInfo.id)) {
        const session = autoJoinSessions.get(userInfo.id);
        
        try {
            if (session.process) {
                session.process.kill('SIGTERM');
            }
            autoJoinSessions.delete(userInfo.id);
            cleanupAutoJoinSession(userInfo.id, session.phoneNumber);
            cancelled = true;
            
            await bot.sendMessage(chatId, `
✅ *Session AutoJoin Dibatalkan*

📱 Nomor: ${session.phoneNumber}
📊 Link tersimpan: ${session.links ? session.links.length : 0}
⏱️ Durasi: ${Math.floor((Date.now() - session.startTime) / 1000)} detik

🗑️ File session telah dibersihkan.
            `, { parse_mode: 'Markdown' });
            
            await logActivity('AUTOJOIN_CANCELLED', userInfo, `Phone: ${session.phoneNumber}`);
        } catch (error) {
            await bot.sendMessage(chatId, '❌ Gagal membatalkan session autojoin.');
            console.error('Error cancelling autojoin session:', error);
        }
    }
    
    if (!cancelled) {
        await bot.sendMessage(chatId, '❌ Tidak ada proses yang sedang berjalan.\n\n• Gunakan `/extract [nomor_wa]` untuk ekstraksi\n• Gunakan `/autojoin [nomor_wa]` untuk auto join', { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/logs/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    if (!isAdmin(userInfo.id)) {
        await bot.sendMessage(chatId, '❌ Hanya admin yang dapat melihat logs.');
        return;
    }
    
    try {
        const logPath = 'telegram_bot.log';
        if (fs.existsSync(logPath)) {
            const stats = await fs.promises.stat(logPath);
            if (stats.size < 10 * 1024 * 1024) { // Max 10MB
                await bot.sendDocument(chatId, logPath, {
                    caption: '📋 Log aktivitas bot\n🕐 ' + new Date().toLocaleString('id-ID')
                });
            } else {
                await bot.sendMessage(chatId, '❌ File log terlalu besar untuk dikirim (>10MB).');
            }
        } else {
            await bot.sendMessage(chatId, '❌ File log tidak ditemukan.');
        }
    } catch (error) {
        await bot.sendMessage(chatId, '❌ Error mengakses file log.');
        console.error('Error sending logs:', error);
    }
});

async function startExtractionProcess(chatId, userInfo, phoneNumber) {
    const processInfo = {
        phoneNumber,
        startTime: Date.now(),
        stage: 'Memulai proses...'
    };
    
    await bot.sendMessage(chatId, `
🚀 *Memulai Ekstraksi Grup WhatsApp*

📱 Nomor: ${phoneNumber}
⏱️ Estimasi waktu: 2-5 menit

📞 Sedang mempersiapkan WhatsApp Web...

💡 *Pastikan:*
• WhatsApp aktif di ponsel dengan nomor ${phoneNumber}
• Koneksi internet stabil
• Jangan tutup WhatsApp selama proses
    `, { parse_mode: 'Markdown' });
    
    try {
        // Spawn the extraction process directly with phone number parameter
        const extractorProcess = spawn('node', ['whatsapp_extractor.js', phoneNumber], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false
        });
        
        processInfo.process = extractorProcess;
        processInfo.stage = 'WhatsApp Web connecting...';
        activeProcesses.set(userInfo.id, processInfo);
        
        let outputBuffer = '';
        let errorBuffer = '';
        let pairingCodeSent = false;
        
        // Handle stdout
        extractorProcess.stdout.on('data', async (data) => {
            const output = data.toString();
            outputBuffer += output;
            
            console.log(`[${userInfo.id}-${phoneNumber}] STDOUT:`, output);
            
            // Check for pairing code
            if (output.includes('KODE PAIRING ANDA:') && !pairingCodeSent) {
                const codeMatch = output.match(/KODE PAIRING ANDA:\s*(\w+)/);
                if (codeMatch) {
                    const pairingCode = codeMatch[1];
                    pairingCodeSent = true;
                    
                    processInfo.stage = 'Menunggu pairing code...';
                    
                    await bot.sendMessage(chatId, `
🔑 *Kode Pairing WhatsApp*

📱 **${pairingCode}**

📱 *Langkah-langkah pairing:*
1. Buka WhatsApp di ponsel dengan nomor **${phoneNumber}**
2. Tap Menu (⋮) → Perangkat Tertaut
3. Tap "Tautkan Perangkat"
4. Tap "Tautkan dengan nomor telepon"
5. Masukkan kode: **${pairingCode}**

⏳ Menunggu konfirmasi pairing untuk nomor ${phoneNumber}...

⚠️ *Penting:* Pastikan Anda menggunakan WhatsApp dengan nomor yang sama!
                    `, { parse_mode: 'Markdown' });
                }
            }
            
            // Check for successful connection
            if (output.includes('Login berhasil')) {
                processInfo.stage = 'Mengekstrak grup...';
                await bot.sendMessage(chatId, `
✅ *WhatsApp Berhasil Terhubung!*

📱 Nomor ${phoneNumber} telah terhubung
📞 Sedang mengekstrak semua grup WhatsApp...

⏳ Proses ini dapat memakan waktu beberapa menit tergantung jumlah grup.
                `, { parse_mode: 'Markdown' });
            }
            
            // Check for completion
            if (output.includes('Ekstraksi selesai')) {
                processInfo.stage = 'Menyelesaikan...';
                await bot.sendMessage(chatId, '🏯 Ekstraksi selesai! Sedang mempersiapkan hasil...');
            }
        });
        
        // Handle stderr
        extractorProcess.stderr.on('data', (data) => {
            const error = data.toString();
            errorBuffer += error;
            console.error(`[${userInfo.id}-${phoneNumber}] STDERR:`, error);
        });
        
        // Handle process completion
        extractorProcess.on('close', async (code) => {
            console.log(`[${userInfo.id}-${phoneNumber}] Process exited with code:`, code);
            
            // Clean up
            activeProcesses.delete(userInfo.id);
            
            if (code === 0) {
                // Process completed successfully
                await handleSuccessfulExtraction(chatId, userInfo, phoneNumber);
            } else {
                // Process failed
                await bot.sendMessage(chatId, `
❌ *Proses Gagal*

📱 Nomor: ${phoneNumber}
💥 Terjadi kesalahan saat mengekstrak grup WhatsApp.

**Kemungkinan penyebab:**
• Kode pairing salah atau expired
• Nomor WhatsApp tidak sesuai atau tidak aktif
• Koneksi internet bermasalah
• WhatsApp Web timeout

💡 **Solusi:**
• Pastikan menggunakan nomor WhatsApp yang benar
• Coba lagi dengan \`/extract ${phoneNumber}\`
• Pastikan WhatsApp aktif di ponsel
                `, { parse_mode: 'Markdown' });
                
                await logActivity('EXTRACTION_FAILED', userInfo, `Phone: ${phoneNumber}, Code: ${code}`);
            }
        });
        
        // Handle process error
        extractorProcess.on('error', async (error) => {
            console.error(`[${userInfo.id}-${phoneNumber}] Process error:`, error);
            
            activeProcesses.delete(userInfo.id);
            
            await bot.sendMessage(chatId, `
❌ *Kesalahan Sistem*

Terjadi kesalahan saat memulai proses ekstraksi.

💡 Silakan coba lagi dengan \`/extract ${phoneNumber}\`
            `, { parse_mode: 'Markdown' });
            
            await logActivity('EXTRACTION_ERROR', userInfo, `Phone: ${phoneNumber}, Error: ${error.message}`);
        });
        
        // Set timeout for process (10 minutes)
        setTimeout(async () => {
            if (activeProcesses.has(userInfo.id)) {
                const processInfo = activeProcesses.get(userInfo.id);
                try {
                    processInfo.process.kill('SIGTERM');
                    activeProcesses.delete(userInfo.id);
                    
                    await bot.sendMessage(chatId, `
⏰ *Proses Timeout*

📱 Nomor: ${phoneNumber}
⏱️ Waktu: 10 menit (maximum)

Proses dihentikan karena melebihi batas waktu maksimum.

💡 **Kemungkinan penyebab:**
• Pairing code tidak dimasukkan
• Koneksi internet lambat
• WhatsApp tidak merespons

Silakan coba lagi dengan \`/extract ${phoneNumber}\`
                    `, { parse_mode: 'Markdown' });
                    
                    await logActivity('EXTRACTION_TIMEOUT', userInfo, `Phone: ${phoneNumber}`);
                } catch (error) {
                    console.error('Error killing timed out process:', error);
                }
            }
        }, 10 * 60 * 1000); // 10 minutes
        
    } catch (error) {
        console.error('Error starting extraction process:', error);
        activeProcesses.delete(userInfo.id);
        
        await bot.sendMessage(chatId, `
❌ *Gagal Memulai Proses*

Terjadi kesalahan saat memulai ekstraksi untuk nomor ${phoneNumber}.

💡 Silakan coba lagi dengan \`/extract ${phoneNumber}\`
        `, { parse_mode: 'Markdown' });
        
        await logActivity('EXTRACTION_START_ERROR', userInfo, `Phone: ${phoneNumber}, Error: ${error.message}`);
    }
}

async function handleSuccessfulExtraction(chatId, userInfo, phoneNumber) {
    try {
        // Look for the generated group files
        const groupDir = 'group';
        if (!fs.existsSync(groupDir)) {
            throw new Error('Group directory not found');
        }
        
        const files = await fs.promises.readdir(groupDir);
        const jsonFiles = files.filter(f => f.endsWith('.json')).sort((a, b) => {
            const statsA = fs.statSync(path.join(groupDir, a));
            const statsB = fs.statSync(path.join(groupDir, b));
            return statsB.mtime - statsA.mtime; // Most recent first
        });
        
        if (jsonFiles.length === 0) {
            throw new Error('No result files found');
        }
        
        const latestFile = jsonFiles[0];
        const filePath = path.join(groupDir, latestFile);
        
        // Read and parse the result
        const fileContent = await fs.promises.readFile(filePath, 'utf8');
        const resultData = JSON.parse(fileContent);
        
        // Send summary message
        const totalGroups = resultData.groups ? resultData.groups.length : 0;
        const successfulLinks = resultData.groups ? resultData.groups.filter(g => g.link && g.link.startsWith('https://')).length : 0;
        const failedLinks = totalGroups - successfulLinks;
        
        await bot.sendMessage(chatId, `
✅ *Ekstraksi Berhasil Selesai!*

📱 **Nomor:** ${phoneNumber}
👤 **Akun:** ${resultData.metadata?.user_name || 'N/A'}

📊 **Ringkasan Hasil:**
👥 Total grup: **${totalGroups}**
📊 Link berhasil: **${successfulLinks}**
❌ Link gagal: **${failedLinks}**

💾 Mengirim file hasil ekstraksi...

⏱️ **Waktu ekstraksi:** ${new Date().toLocaleString('id-ID')}
        `, { parse_mode: 'Markdown' });
        
        // Send the result file
        await bot.sendDocument(chatId, filePath, {
            caption: `📋 **Hasil Ekstraksi Grup WhatsApp**\n\n📱 Nomor: ${phoneNumber}\n👥 Total grup: ${totalGroups}\n📊 Link berhasil: ${successfulLinks}\n🕐 ${new Date().toLocaleString('id-ID')}`
        });
        
        // Send detailed info if there are failed links
        if (failedLinks > 0) {
            await bot.sendMessage(chatId, `
ℹ️ **Informasi Link yang Gagal:**

${failedLinks} grup tidak dapat diambil linknya, kemungkinan karena:
• Anda bukan admin di grup tersebut
• Grup tidak mengizinkan invite link
• Grup sudah tidak aktif

💡 Hanya admin grup yang dapat mengambil invite link.
            `, { parse_mode: 'Markdown' });
        }
        
        await logActivity('EXTRACTION_SUCCESS', userInfo, `Phone: ${phoneNumber}, Groups: ${totalGroups}, Success: ${successfulLinks}`);
        
    } catch (error) {
        console.error('Error handling successful extraction:', error);
        
        await bot.sendMessage(chatId, `
✅ **Proses Ekstraksi Selesai**

📱 Nomor: ${phoneNumber}

⚠️ Terjadi masalah saat memproses hasil, tetapi file mungkin sudah tersimpan.

💡 Silakan cek folder 'group' di server untuk file hasil ekstraksi.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('EXTRACTION_RESULT_ERROR', userInfo, `Phone: ${phoneNumber}, Error: ${error.message}`);
    }
}

// Error handling
bot.on('polling_error', (error) => {
    console.error('Telegram polling error:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down bot...');
    
    // Kill all active processes
    for (const [userId, processInfo] of activeProcesses) {
        try {
            processInfo.process.kill('SIGTERM');
            console.log(`Killed extraction process for user ${userId} (phone: ${processInfo.phoneNumber})`);
        } catch (error) {
            console.error(`Error killing extraction process for user ${userId}:`, error);
        }
    }
    
    // Kill all autojoin sessions and cleanup
    for (const [userId, sessionInfo] of autoJoinSessions) {
        try {
            if (sessionInfo.process) {
                sessionInfo.process.kill('SIGTERM');
                console.log(`Killed autojoin session for user ${userId} (phone: ${sessionInfo.phoneNumber})`);
            }
            cleanupAutoJoinSession(userId, sessionInfo.phoneNumber);
        } catch (error) {
            console.error(`Error killing autojoin session for user ${userId}:`, error);
        }
    }
    
    bot.stopPolling();
    process.exit(0);
});

console.log('🤖 Telegram Bot v2.4.1 started successfully!');
console.log('👑 Owner ID:', OWNER_ID);

// Load and display current admins
const currentAdmins = loadAdmins();
const regularAdmins = currentAdmins.filter(id => id !== OWNER_ID);
console.log(`👥 Current admins: ${regularAdmins.length > 0 ? regularAdmins.join(', ') : 'None (only owner)'}`);
console.log(`📊 Total authorized users: ${currentAdmins.length} (including owner)`);

console.log('📱 Bot is ready to receive commands...');
console.log('');
console.log('🆕 New in v2.4.1:');
console.log('   • Fixed autojoin report generation and session cleanup');
console.log('   • Improved TXT file delivery for successful join results');
console.log('   • Better session management and file cleanup');
console.log('   • Fixed bug where session closed before sending reports');
console.log('   • Enhanced error handling and user feedback');