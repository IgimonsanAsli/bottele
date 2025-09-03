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
    console.error('âŒ TELEGRAM_BOT_TOKEN tidak ditemukan di file .env');
    process.exit(1);
}

if (!OWNER_ID) {
    console.error('âŒ OWNER_ID tidak ditemukan di file .env');
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
        console.log('âœ… admin.json created with owner as initial admin');
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

function cleanupExtractionSession(phoneNumber) {
    const authDir = `auth_${phoneNumber}`;
    const sessionFiles = [
        '.wwebjs_auth',
        '.wwebjs_cache'
    ];
    
    // Clean up auth directory khusus untuk phone number
    if (fs.existsSync(authDir)) {
        try {
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log(`Cleaned up extraction auth directory: ${authDir}`);
        } catch (e) {
            console.error(`Error cleaning auth directory ${authDir}:`, e);
        }
    }
    
    // Clean up session files yang mungkin dibuat oleh whatsapp_extractor.js
    sessionFiles.forEach(file => {
        if (fs.existsSync(file)) {
            try {
                if (fs.statSync(file).isDirectory()) {
                    fs.rmSync(file, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(file);
                }
                console.log(`Cleaned up session file/folder: ${file}`);
            } catch (e) {
                console.error(`Error deleting ${file}:`, e);
            }
        }
    });
    
    // Clean up any session files with phone number suffix
    try {
        const files = fs.readdirSync('.');
        const sessionFilesToDelete = files.filter(file => 
            file.includes(phoneNumber) && (
                file.includes('session') || 
                file.includes('auth') || 
                file.includes('wwebjs') ||
                file.startsWith('session_') ||
                file.endsWith('.session')
            )
        );
        
        sessionFilesToDelete.forEach(file => {
            try {
                if (fs.existsSync(file)) {
                    if (fs.statSync(file).isDirectory()) {
                        fs.rmSync(file, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(file);
                    }
                    console.log(`Cleaned up phone-specific session: ${file}`);
                }
            } catch (e) {
                console.error(`Error deleting ${file}:`, e);
            }
        });
    } catch (e) {
        console.error('Error scanning for session files:', e);
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
        roleInfo = 'ðŸ‘‘ Anda adalah owner dan dapat menggunakan semua fitur.';
    } else if (isAdmin(userInfo.id)) {
        roleInfo = 'âœ… Anda adalah admin dan dapat menggunakan fitur ekstraksi.';
    } else {
        roleInfo = 'âŒ Anda bukan admin. Akses terbatas.';
    }
    
    const welcomeMessage = `
ðŸ¤– *IGIMONSAN BOT*

Selamat datang! Bot ini dapat membantu Anda mengekstrak dan join grup WhatsApp secara otomatis.

ðŸ“‹ *Perintah yang tersedia:*
â€¢ \`/extract [nomor_wa]\` - Ekstrak grup WhatsApp
â€¢ \`/autojoin [nomor_wa]\` - Auto join grup WhatsApp
â€¢ \`/status\` - Cek status proses
â€¢ \`/cancel\` - Batalkan proses aktif
â€¢ \`/help\` - Bantuan penggunaan

${isOwner(userInfo.id) ? `
ðŸ‘‘ *Perintah Owner:*
â€¢ \`/addadmin [user_id]\` - Tambah admin baru
â€¢ \`/removeadmin [user_id]\` - Hapus admin
â€¢ \`/showadmin\` - Lihat semua admin
` : ''}

ðŸ“± *Format nomor WhatsApp:*
â€¢ Indonesia: 628123456789
â€¢ Malaysia: 60123456789
â€¢ Singapura: 6512345678

âš¡ *Contoh penggunaan:*
\`/extract 628123456789\`
\`/autojoin 628123456789\`

${roleInfo}

ðŸ†• *Update v2.4.1:*
â€¢ Perbaikan sistem pelaporan autojoin
â€¢ Pembersihan session yang lebih baik
â€¢ Laporan hasil dalam format TXT
â€¢ Perbaikan bug session tidak tertutup
    `;
    
    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    await logActivity('HELP_COMMAND', userInfo);
    
    const ownerCommands = isOwner(userInfo.id) ? `

ðŸ‘‘ *Perintah Owner:*
\`/addadmin [user_id]\` - Menambahkan admin baru ke sistem
\`/removeadmin [user_id]\` - Menghapus admin dari sistem
\`/showadmin\` - Melihat daftar semua admin yang aktif

ðŸ“¸ *Manajemen Admin:*
â€¢ Hanya owner yang dapat mengelola admin
â€¢ Admin disimpan di file admin.json
â€¢ Owner selalu menjadi admin otomatis
â€¢ Owner tidak dapat dihapus dari sistem
` : '';
    
    const helpMessage = `
ðŸ“š *Bantuan Penggunaan Bot v2.4.1*

ðŸ“¸ *Perintah Utama:*
\`/extract [nomor_wa]\` - Memulai proses ekstraksi grup WhatsApp
\`/autojoin [nomor_wa]\` - Memulai proses auto join grup WhatsApp

ðŸ“¸ *AutoJoin Commands:*
\`/addlinks\` - Tambah link grup untuk autojoin (saat session aktif)
\`/join\` - Mulai proses join ke semua grup (saat session aktif)

ðŸ“¸ *Perintah Lain:*
â€¢ \`/status\` - Cek apakah ada proses yang berjalan
â€¢ \`/cancel\` - Batalkan proses yang sedang berjalan
â€¢ \`/logs\` - Lihat log aktivitas (admin only)
${ownerCommands}

ðŸ”„ *Alur AutoJoin:*
1. \`/autojoin [nomor_wa]\` - Mulai session
2. Masukkan pairing code di WhatsApp
3. \`/addlinks\` - Kirim link grup yang ingin dijoin
4. \`/join\` - Konfirmasi dan mulai join semua grup

âš ï¸ *Catatan Penting:*
â€¢ Gunakan nomor WhatsApp Anda sendiri
â€¢ Proses dapat memakan waktu 2-5 menit
â€¢ Pastikan WhatsApp aktif di ponsel saat proses berjalan
â€¢ Hasil akan berupa file TXT dengan link yang berhasil dijoin
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
        await bot.sendMessage(chatId, 'âŒ Maaf, hanya admin yang dapat menggunakan fitur ini.');
        return;
    }
    
    // Check if phone number is provided
    if (!phoneNumber) {
        await bot.sendMessage(chatId, `
âŒ *Format perintah salah!*

Gunakan format: \`/autojoin [nomor_wa]\`

ðŸ“± *Contoh:*
\`/autojoin 628123456789\` (Indonesia)
\`/autojoin 60123456789\` (Malaysia)
\`/autojoin 6512345678\` (Singapura)

ðŸ’¡ *Tips:*
â€¢ Gunakan nomor WhatsApp Anda sendiri
â€¢ Format internasional tanpa tanda + atau spasi
â€¢ Pastikan nomor aktif dan terhubung dengan WhatsApp
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Validate phone number
    const phoneValidation = validatePhoneNumber(phoneNumber);
    if (!phoneValidation.valid) {
        await bot.sendMessage(chatId, `âŒ ${phoneValidation.error}`);
        return;
    }
    
    // Check if user already has active autojoin session
    if (autoJoinSessions.has(userInfo.id)) {
        const session = autoJoinSessions.get(userInfo.id);
        await bot.sendMessage(chatId, `
âš ï¸ Anda sudah memiliki session autojoin yang aktif!

ðŸ“± Nomor aktif: ${session.phoneNumber}
ðŸ“Š Link tersimpan: ${session.links ? session.links.length : 0}

Gunakan \`/addlinks\` untuk menambah link grup atau \`/join\` untuk memulai join.
Atau gunakan \`/cancel\` untuk membatalkan session ini.
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Check if user has active extraction process
    if (activeProcesses.has(userInfo.id)) {
        await bot.sendMessage(chatId, `
âš ï¸ Anda sudah memiliki proses ekstraksi yang sedang berjalan!

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
âŒ *Tidak ada session autojoin yang aktif!*

Mulai session autojoin terlebih dahulu dengan:
\`/autojoin [nomor_wa]\`

Contoh: \`/autojoin 628123456789\`
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    const session = autoJoinSessions.get(userInfo.id);
    
    if (session.stage !== 'connected') {
        await bot.sendMessage(chatId, `
âš ï¸ *Session belum siap untuk menerima link!*

ðŸ“Š Status saat ini: ${session.stage}

Tunggu hingga WhatsApp berhasil terhubung, lalu coba lagi.
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    await bot.sendMessage(chatId, `
ðŸ“ *Kirim Link Grup WhatsApp*

ðŸ“± Session aktif: ${session.phoneNumber}
ðŸ“Š Link tersimpan: ${session.links ? session.links.length : 0}

ðŸ’¡ *Cara mengirim link:*
â€¢ Kirim 1 link per pesan atau beberapa sekaligus
â€¢ Bot akan otomatis mendeteksi dan menyimpan link
â€¢ Anda bisa mengirim link kapan saja selama session aktif

ðŸ”— *Format link yang diterima:*
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
âŒ *Tidak ada session autojoin yang aktif!*

Mulai session autojoin terlebih dahulu dengan:
\`/autojoin [nomor_wa]\`
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    const session = autoJoinSessions.get(userInfo.id);
    
    if (!session.links || session.links.length === 0) {
        await bot.sendMessage(chatId, `
âŒ *Belum ada link grup yang disimpan!*

Gunakan \`/addlinks\` untuk menambahkan link grup terlebih dahulu.

ðŸ“ Atau langsung kirim link grup WhatsApp ke chat ini.
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Show confirmation
    await bot.sendMessage(chatId, `
ðŸ¯ *Konfirmasi Auto Join*

ðŸ“± Nomor: ${session.phoneNumber}
ðŸ“Š Total link grup: ${session.links.length}

ðŸ“‹ *Link yang akan dijoin:*
${session.links.slice(0, 10).map((link, i) => `${i + 1}. ${link}`).join('\n')}
${session.links.length > 10 ? `\n... dan ${session.links.length - 10} link lainnya` : ''}

âš ï¸ *Peringatan:*
â€¢ Proses ini akan join SEMUA grup dalam daftar
â€¢ Tidak dapat dibatalkan setelah dimulai
â€¢ Estimasi waktu: ${Math.ceil(session.links.length * 1.5)} detik

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
        await bot.sendMessage(chatId, 'âŒ Tidak ada session yang menunggu konfirmasi.');
        return;
    }
    
    const session = autoJoinSessions.get(userInfo.id);
    
    if (session.stage !== 'confirm_join') {
        await bot.sendMessage(chatId, 'âŒ Session tidak dalam tahap konfirmasi.');
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
ðŸš€ *Memulai AutoJoin WhatsApp*

ðŸ“± Nomor: ${phoneNumber}
â±ï¸ Estimasi waktu: 2-5 menit

ðŸ“ž Sedang mempersiapkan WhatsApp Web...

ðŸ’¡ *Pastikan:*
â€¢ WhatsApp aktif di ponsel dengan nomor ${phoneNumber}
â€¢ Koneksi internet stabil
â€¢ Jangan tutup WhatsApp selama proses
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
ðŸ”‘ *Kode Pairing WhatsApp*

ðŸ“± **${pairingCode}**

ðŸ“± *Langkah-langkah pairing:*
1. Buka WhatsApp di ponsel dengan nomor **${phoneNumber}**
2. Tap Menu (â‹®) â†’ Perangkat Tertaut
3. Tap "Tautkan Perangkat"
4. Tap "Tautkan dengan nomor telepon"
5. Masukkan kode: **${pairingCode}**

â³ Menunggu konfirmasi pairing untuk nomor ${phoneNumber}...

âš ï¸ *Penting:* Pastikan Anda menggunakan WhatsApp dengan nomor yang sama!
                    `, { parse_mode: 'Markdown' });
                }
            }
            
            // Check for successful connection
            if (output.includes('Login berhasil')) {
                sessionInfo.stage = 'connected';
                autoJoinSessions.set(userInfo.id, sessionInfo);
                
                await bot.sendMessage(chatId, `
âœ… *WhatsApp Berhasil Terhubung!*

ðŸ“± Nomor ${phoneNumber} telah terhubung
ðŸ¯ Session autojoin siap digunakan

ðŸ“ *Langkah selanjutnya:*
â€¢ Gunakan \`/addlinks\` untuk menambah link grup
â€¢ Atau langsung kirim link grup WhatsApp ke chat ini
â€¢ Setelah selesai, gunakan \`/join\` untuk memulai join

ðŸ’¡ *Tips:*
â€¢ Anda bisa mengirim banyak link sekaligus
â€¢ Link akan otomatis tersimpan dan divalidasi
â€¢ Session akan aktif selama 30 menit
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
âœ… *Proses AutoJoin Selesai!*

ðŸ“± Nomor: ${phoneNumber}
ðŸ¯ Semua grup telah diproses

ðŸ“Š Sedang mempersiapkan laporan hasil...
                `, { parse_mode: 'Markdown' });
            } else {
                // Process failed, clean up session
                autoJoinSessions.delete(userInfo.id);
                cleanupAutoJoinSession(userInfo.id, phoneNumber);
                
                await bot.sendMessage(chatId, `
âŒ *Proses AutoJoin Gagal*

ðŸ“± Nomor: ${phoneNumber}
ðŸ’¥ Terjadi kesalahan saat proses autojoin.

**Kemungkinan penyebab:**
â€¢ Kode pairing salah atau expired
â€¢ Nomor WhatsApp tidak sesuai atau tidak aktif
â€¢ Koneksi internet bermasalah
â€¢ Session timeout

ðŸ’¡ **Solusi:**
â€¢ Pastikan menggunakan nomor WhatsApp yang benar
â€¢ Coba lagi dengan \`/autojoin ${phoneNumber}\`
â€¢ Pastikan WhatsApp aktif di ponsel
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
âŒ *Kesalahan Sistem*

Terjadi kesalahan saat memulai proses autojoin.

ðŸ’¡ Silakan coba lagi dengan \`/autojoin ${phoneNumber}\`
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
â° *Session AutoJoin Timeout*

ðŸ“± Nomor: ${phoneNumber}
â±ï¸ Waktu: 30 menit (maximum)

Session dihentikan karena melebihi batas waktu maksimum.

ðŸ’¡ Silakan mulai session baru dengan \`/autojoin ${phoneNumber}\`
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
âŒ *Gagal Memulai AutoJoin*

Terjadi kesalahan saat memulai proses untuk nomor ${phoneNumber}.

ðŸ’¡ Silakan coba lagi dengan \`/autojoin ${phoneNumber}\`
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
ðŸ¯ *Memulai Proses Join Grup*

ðŸ“± Nomor: ${session.phoneNumber}
ðŸ“Š Total grup: ${session.links.length}
â±ï¸ Estimasi waktu: ${Math.ceil(session.links.length * 1.5)} detik

ðŸš€ Sedang join grup satu per satu...

ðŸ’¡ Proses akan berjalan otomatis dengan delay 0-1 detik per grup untuk menghindari spam detection.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('JOIN_PROCESS_STARTED', userInfo, `Phone: ${session.phoneNumber}, Links: ${session.links.length}`);
        
    } catch (error) {
        console.error('Error starting join process:', error);
        await bot.sendMessage(chatId, 'âŒ Gagal memulai proses join. Silakan coba lagi.');
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
ðŸ† *AutoJoin Selesai!*

ðŸ“± **Nomor:** ${phoneNumber}
ðŸ“Š **Hasil Join:**

âœ… **Berhasil join:** ${successful.length} grup
ðŸ‘¥ **Sudah member:** ${alreadyMember.length} grup
âŒ **Gagal join:** ${failed.length} grup
ðŸ“Š **Total diproses:** ${totalProcessed} grup

â±ï¸ **Selesai pada:** ${new Date().toLocaleString('id-ID')}

ðŸ“„ Mengirim laporan hasil...
                `, { parse_mode: 'Markdown' });
                
                // Create and send TXT file with successful links only
                if (successful.length > 0) {
                    const successfulLinks = successful.map(r => r.link).join('\n');
                    const txtFileName = `autojoin_success_${phoneNumber}_${userId}_${Date.now()}.txt`;
                    
                    fs.writeFileSync(txtFileName, successfulLinks);
                    console.log(`Created TXT file: ${txtFileName} with ${successful.length} successful links`);
                    
                    await bot.sendDocument(chatId, txtFileName, {
                        caption: `ðŸ“„ **Link Grup yang Berhasil Dijoin**\n\nâœ… ${successful.length} grup berhasil dijoin\nðŸ“± Nomor: ${phoneNumber}`
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
ðŸ“„ **Tidak ada grup yang berhasil dijoin**

âŒ Semua ${totalProcessed} grup gagal dijoin atau sudah menjadi member.

**Kemungkinan penyebab:**
â€¢ Link grup sudah expired atau tidak valid
â€¢ Grup sudah private atau tidak menerima member baru
â€¢ Anda sudah menjadi member di semua grup
â€¢ Rate limit dari WhatsApp

ðŸ’¡ Coba gunakan link grup yang lebih baru dan pastikan masih aktif.
                    `, { parse_mode: 'Markdown' });
                }
                
                // Also send JSON report for detailed info
                await bot.sendDocument(chatId, latestReportFile, {
                    caption: `ðŸ“‹ **Laporan Detail AutoJoin**\n\nðŸ“± Nomor: ${phoneNumber}\nðŸ“Š Total: ${totalProcessed} grup\nðŸ• ${new Date().toLocaleString('id-ID')}`
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
âŒ **Error membaca laporan hasil**

ðŸ“± Nomor: ${phoneNumber}
ðŸ’¥ Terjadi kesalahan saat membaca file laporan.

Proses mungkin sudah selesai tetapi laporan tidak dapat dibaca.
                `, { parse_mode: 'Markdown' });
            }
        } else {
            console.log(`No report files found for phone ${phoneNumber}`);
            await bot.sendMessage(chatId, `
âš ï¸ **File laporan tidak ditemukan**

ðŸ“± Nomor: ${phoneNumber}
ðŸ“Š Proses mungkin belum selesai sepenuhnya atau terjadi kesalahan.

ðŸ’¡ Gunakan \`/status\` untuk cek status atau coba lagi dengan \`/autojoin ${phoneNumber}\`
            `, { parse_mode: 'Markdown' });
        }
        
        // Send final completion message
        await bot.sendMessage(chatId, `
ðŸŽ¯ **AutoJoin Session Ditutup**

ðŸ“± **Nomor:** ${phoneNumber}
ðŸ“Š **Statistik Final:**
âœ… Berhasil join: **${successful.length}** grup
ðŸ‘¥ Sudah member: **${alreadyMember.length}** grup  
âŒ Gagal join: **${failed.length}** grup

ðŸ—‚ï¸ **File yang dikirim:**
${successful.length > 0 ? 'â€¢ Daftar link berhasil (TXT)' : 'â€¢ Tidak ada link berhasil'}
â€¢ Laporan detail (JSON)

ðŸ”’ **Keamanan:** Session WhatsApp telah dihapus otomatis.

ðŸ’¡ Gunakan \`/autojoin [nomor]\` untuk session baru.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('AUTOJOIN_RESULTS_SENT', { id: userId }, `Phone: ${phoneNumber}, Success: ${successful.length}, Total: ${totalProcessed}`);
        
    } catch (error) {
        console.error('Error sending join results:', error);
        
        // Still cleanup session even if sending results failed
        autoJoinSessions.delete(userId);
        cleanupAutoJoinSession(userId, phoneNumber);
        
        await bot.sendMessage(chatId, `
âŒ **Kesalahan mengirim laporan**

ðŸ“± Nomor: ${phoneNumber}
ðŸ’¥ Terjadi kesalahan saat mengirim hasil.

ðŸ”’ Session telah ditutup untuk keamanan.
ðŸ’¡ Silakan coba lagi dengan \`/autojoin ${phoneNumber}\`
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
âœ… *Link Grup Berhasil Ditambahkan*

ðŸ“Š **Link baru:** ${newLinks.length}
ðŸ“Š **Total link:** ${session.links.length}
ðŸ“± **Session:** ${session.phoneNumber}

ðŸ’¡ *Link yang ditambahkan:*
${newLinks.slice(0, 5).map((link, i) => `${i + 1}. ${link.substring(0, 50)}...`).join('\n')}
${newLinks.length > 5 ? `\n... dan ${newLinks.length - 5} link lainnya` : ''}

ðŸ“ **Lanjutkan:**
â€¢ Kirim lebih banyak link grup, atau
â€¢ Gunakan \`/join\` untuk mulai join semua grup

â³ Session aktif hingga ${new Date(session.startTime + 30 * 60 * 1000).toLocaleString('id-ID')}
                    `, { parse_mode: 'Markdown' });
                    
                    await logActivity('LINKS_ADDED', userInfo, `Phone: ${session.phoneNumber}, New: ${newLinks.length}, Total: ${session.links.length}`);
                } else {
                    await bot.sendMessage(chatId, 'âŒ Link grup tidak valid atau sudah ada dalam daftar.');
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
        await bot.sendMessage(chatId, 'âŒ Hanya owner yang dapat menambahkan admin baru.');
        return;
    }
    
    // Check if target user ID is provided
    if (!targetUserId) {
        await bot.sendMessage(chatId, `
âŒ *Format perintah salah!*

Gunakan format: \`/addadmin [user_id]\`

ðŸ”¢ *Contoh:*
\`/addadmin 123456789\`

ðŸ’¡ *Tips:*
â€¢ User ID adalah nomor ID unik Telegram
â€¢ User bisa mendapatkan ID mereka dengan mengirim pesan ke bot @userinfobot
â€¢ Pastikan ID yang dimasukkan benar
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Check if target is owner
    if (targetUserId === OWNER_ID) {
        await bot.sendMessage(chatId, 'âŒ Owner sudah otomatis menjadi admin.');
        return;
    }
    
    // Load current admins
    const currentAdmins = loadAdmins();
    
    // Check if user is already admin
    if (currentAdmins.includes(targetUserId)) {
        await bot.sendMessage(chatId, `âŒ User ID ${targetUserId} sudah menjadi admin.`);
        return;
    }
    
    // Add new admin
    const newAdmins = [...currentAdmins, targetUserId];
    
    if (saveAdmins(newAdmins)) {
        await bot.sendMessage(chatId, `
âœ… *Admin Berhasil Ditambahkan!*

ðŸ‘¤ **User ID:** ${targetUserId}
ðŸ“Š **Total admin sekarang:** ${newAdmins.length + 1} (termasuk owner)

ðŸ’¡ Admin baru dapat langsung menggunakan fitur ekstraksi.

Gunakan \`/showadmin\` untuk melihat semua admin.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('ADMIN_ADDED', userInfo, `New admin: ${targetUserId}`);
        
        // Try to notify the new admin (optional, might fail if they haven't started the bot)
        try {
            await bot.sendMessage(targetUserId, `
ðŸ† *Anda telah ditambahkan sebagai admin!*

âœ… Anda sekarang dapat menggunakan fitur ekstraksi grup WhatsApp.

ðŸ“‹ Gunakan \`/help\` untuk melihat perintah yang tersedia.

Mulai dengan \`/extract [nomor_wa]\` untuk mengekstrak grup.
            `, { parse_mode: 'Markdown' });
        } catch (error) {
            // User hasn't started the bot yet, ignore error
            console.log(`Could not notify new admin ${targetUserId}: ${error.message}`);
        }
    } else {
        await bot.sendMessage(chatId, 'âŒ Gagal menyimpan admin baru. Silakan coba lagi.');
    }
});

bot.onText(/\/showadmin/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    await logActivity('SHOWADMIN_COMMAND', userInfo);
    
    // Check if user is owner
    if (!isOwner(userInfo.id)) {
        await bot.sendMessage(chatId, 'âŒ Hanya owner yang dapat melihat daftar admin.');
        return;
    }
    
    const admins = loadAdmins();
    
    let adminList = `ðŸ‘‘ **Owner:** ${OWNER_ID}\n\n`;
    
    if (admins.length > 0) {
        adminList += `âœ… **Admin List:**\n`;
        admins.forEach((adminId, index) => {
            if (adminId !== OWNER_ID) { // Don't show owner twice
                adminList += `${index + 1}. ${adminId}\n`;
            }
        });
    } else {
        adminList += `ðŸ“ **Admin List:** Kosong (hanya owner)`;
    }
    
    const totalAdmins = admins.filter(id => id !== OWNER_ID).length;
    
    await bot.sendMessage(chatId, `
ðŸ‘¥ *Daftar Admin Bot*

${adminList}

ðŸ“Š **Statistik:**
â€¢ Total admin: ${totalAdmins}
â€¢ Total pengguna authorized: ${totalAdmins + 1} (termasuk owner)

ðŸ’¡ Gunakan \`/addadmin [user_id]\` untuk menambah admin baru.
ðŸ’¡ Gunakan \`/removeadmin [user_id]\` untuk menghapus admin.

ðŸ• **Last updated:** ${new Date().toLocaleString('id-ID')}
    `, { parse_mode: 'Markdown' });
});

bot.onText(/\/removeadmin(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    const targetUserId = match[1] ? parseInt(match[1]) : null;
    
    await logActivity('REMOVEADMIN_COMMAND', userInfo, `Target: ${targetUserId || 'not provided'}`);
    
    // Check if user is owner
    if (!isOwner(userInfo.id)) {
        await bot.sendMessage(chatId, 'âŒ Hanya owner yang dapat menghapus admin.');
        return;
    }
    
    // Check if target user ID is provided
    if (!targetUserId) {
        await bot.sendMessage(chatId, `
âŒ *Format perintah salah!*

Gunakan format: \`/removeadmin [user_id]\`

ðŸ”¢ *Contoh:*
\`/removeadmin 123456789\`

ðŸ’¡ *Tips:*
â€¢ Masukkan User ID yang ingin dihapus dari admin
â€¢ Gunakan \`/showadmin\` untuk melihat daftar admin
â€¢ Owner tidak dapat dihapus dari sistem
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Check if trying to remove owner
    if (targetUserId === OWNER_ID) {
        await bot.sendMessage(chatId, 'âŒ Owner tidak dapat dihapus dari sistem admin.');
        return;
    }
    
    // Load current admins
    const currentAdmins = loadAdmins();
    
    // Check if user is actually an admin
    if (!currentAdmins.includes(targetUserId)) {
        await bot.sendMessage(chatId, `âŒ User ID ${targetUserId} bukan admin atau tidak ditemukan.`);
        return;
    }
    
    // Remove admin
    const newAdmins = currentAdmins.filter(id => id !== targetUserId);
    
    if (saveAdmins(newAdmins)) {
        await bot.sendMessage(chatId, `
âœ… *Admin Berhasil Dihapus!*

ðŸ‘¤ **User ID yang dihapus:** ${targetUserId}
ðŸ“Š **Total admin sekarang:** ${newAdmins.filter(id => id !== OWNER_ID).length} (tidak termasuk owner)

ðŸ’¡ User ini tidak dapat lagi menggunakan fitur ekstraksi.

Gunakan \`/showadmin\` untuk melihat admin yang tersisa.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('ADMIN_REMOVED', userInfo, `Removed admin: ${targetUserId}`);
        
        // Try to notify the removed admin (optional, might fail if they haven't started the bot)
        try {
            await bot.sendMessage(targetUserId, `
âš ï¸ *Status Admin Dicabut*

âŒ Anda telah dihapus dari daftar admin bot.

ðŸ”’ Anda tidak dapat lagi menggunakan fitur ekstraksi grup WhatsApp.

ðŸ’¡ Hubungi owner jika ada kesalahan atau untuk mendapatkan akses kembali.
            `, { parse_mode: 'Markdown' });
        } catch (error) {
            // User might have blocked bot or not started it, ignore error
            console.log(`Could not notify removed admin ${targetUserId}: ${error.message}`);
        }
    } else {
        await bot.sendMessage(chatId, 'âŒ Gagal menghapus admin. Silakan coba lagi.');
    }
});

bot.onText(/\/extract(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    const phoneNumber = match[1];
    
    await logActivity('EXTRACT_COMMAND', userInfo, `Phone: ${phoneNumber || 'not provided'}`);
    
    // Check if user is admin
    if (!isAdmin(userInfo.id)) {
        await bot.sendMessage(chatId, 'âŒ Maaf, hanya admin yang dapat menggunakan fitur ini.');
        return;
    }
    
    // Check if phone number is provided
    if (!phoneNumber) {
        await bot.sendMessage(chatId, `
âŒ *Format perintah salah!*

Gunakan format: \`/extract [nomor_wa]\`

ðŸ“± *Contoh:*
\`/extract 628123456789\` (Indonesia)
\`/extract 60123456789\` (Malaysia)
\`/extract 6512345678\` (Singapura)

ðŸ’¡ *Tips:*
â€¢ Gunakan nomor WhatsApp Anda sendiri
â€¢ Format internasional tanpa tanda + atau spasi
â€¢ Pastikan nomor aktif dan terhubung dengan WhatsApp
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Validate phone number
    const phoneValidation = validatePhoneNumber(phoneNumber);
    if (!phoneValidation.valid) {
        await bot.sendMessage(chatId, `âŒ ${phoneValidation.error}`);
        return;
    }
    
    // Check if user already has active process
    if (activeProcesses.has(userInfo.id)) {
        await bot.sendMessage(chatId, `
âš ï¸ Anda sudah memiliki proses yang sedang berjalan!

ðŸ“± Nomor aktif: ${activeProcesses.get(userInfo.id).phoneNumber}

Gunakan \`/status\` untuk melihat status atau \`/cancel\` untuk membatalkan.
        `, { parse_mode: 'Markdown' });
        return;
    }
    
    // Check if user has active autojoin session
    if (autoJoinSessions.has(userInfo.id)) {
        await bot.sendMessage(chatId, `
âš ï¸ Anda sudah memiliki session autojoin yang aktif!

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
ðŸ“Š *Status Ekstraksi*

ðŸ“ž Status: Sedang berjalan
ðŸ“± Nomor: ${processInfo.phoneNumber}
â±ï¸ Durasi: ${duration} detik
ðŸ¯ Tahap: ${processInfo.stage || 'Inisialisasi'}

â³ Silakan tunggu proses selesai...
        `;
    }
    
    // Check autojoin session
    if (autoJoinSessions.has(userInfo.id)) {
        const session = autoJoinSessions.get(userInfo.id);
        const duration = Math.floor((Date.now() - session.startTime) / 1000);
        
        statusMessage += `
ðŸ¤– *Status AutoJoin*

ðŸ“ž Status: ${session.stage}
ðŸ“± Nomor: ${session.phoneNumber}
â±ï¸ Durasi: ${duration} detik
ðŸ“Š Link tersimpan: ${session.links ? session.links.length : 0}

${session.stage === 'connected' || session.stage === 'waiting_links' ? 
  'ðŸ’¡ Gunakan `/addlinks` untuk menambah link atau langsung kirim link grup.' : 
  'â³ Silakan tunggu proses selesai...'}
        `;
    }
    
    if (!statusMessage) {
        statusMessage = 'âœ… Tidak ada proses yang sedang berjalan.\n\nâ€¢ Gunakan `/extract [nomor_wa]` untuk ekstraksi grup\nâ€¢ Gunakan `/autojoin [nomor_wa]` untuk auto join grup';
    }
    
    await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    await logActivity('CANCEL_COMMAND', userInfo);
    
    if (!isAdmin(userInfo.id)) {
        await bot.sendMessage(chatId, 'âŒ Hanya admin yang dapat membatalkan proses.');
        return;
    }
    
    let cancelled = false;
    
    // Cancel extraction process
    if (activeProcesses.has(userInfo.id)) {
    const processInfo = activeProcesses.get(userInfo.id);
    
    try {
        processInfo.process.kill('SIGTERM');
        activeProcesses.delete(userInfo.id);
        
        // Clean up session saat cancel
        setTimeout(() => {
            cleanupExtractionSession(processInfo.phoneNumber);
        }, 2000);
        
        cancelled = true;
        
        await bot.sendMessage(chatId, `
✅ *Proses Ekstraksi Dibatalkan*

📱 Nomor: ${processInfo.phoneNumber}
⏱️ Durasi sebelum dibatalkan: ${Math.floor((Date.now() - processInfo.startTime) / 1000)} detik
🗂️ Session files akan dibersihkan otomatis

🔒 Semua file session dan auth telah dihapus untuk keamanan.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('EXTRACTION_CANCELLED_WITH_CLEANUP', userInfo, `Phone: ${processInfo.phoneNumber}`);
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
âœ… *Session AutoJoin Dibatalkan*

ðŸ“± Nomor: ${session.phoneNumber}
ðŸ“Š Link tersimpan: ${session.links ? session.links.length : 0}
â±ï¸ Durasi: ${Math.floor((Date.now() - session.startTime) / 1000)} detik

ðŸ—‘ï¸ File session telah dibersihkan.
            `, { parse_mode: 'Markdown' });
            
            await logActivity('AUTOJOIN_CANCELLED', userInfo, `Phone: ${session.phoneNumber}`);
        } catch (error) {
            await bot.sendMessage(chatId, 'âŒ Gagal membatalkan session autojoin.');
            console.error('Error cancelling autojoin session:', error);
        }
    }
    
    if (!cancelled) {
        await bot.sendMessage(chatId, 'âŒ Tidak ada proses yang sedang berjalan.\n\nâ€¢ Gunakan `/extract [nomor_wa]` untuk ekstraksi\nâ€¢ Gunakan `/autojoin [nomor_wa]` untuk auto join', { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/logs/, async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = getUserInfo(msg);
    
    if (!isAdmin(userInfo.id)) {
        await bot.sendMessage(chatId, 'âŒ Hanya admin yang dapat melihat logs.');
        return;
    }
    
    try {
        const logPath = 'telegram_bot.log';
        if (fs.existsSync(logPath)) {
            const stats = await fs.promises.stat(logPath);
            if (stats.size < 10 * 1024 * 1024) { // Max 10MB
                await bot.sendDocument(chatId, logPath, {
                    caption: 'ðŸ“‹ Log aktivitas bot\nðŸ• ' + new Date().toLocaleString('id-ID')
                });
            } else {
                await bot.sendMessage(chatId, 'âŒ File log terlalu besar untuk dikirim (>10MB).');
            }
        } else {
            await bot.sendMessage(chatId, 'âŒ File log tidak ditemukan.');
        }
    } catch (error) {
        await bot.sendMessage(chatId, 'âŒ Error mengakses file log.');
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
⏱️ Proses tidak terbatas waktu (untuk ekstraksi grup dalam jumlah besar)

🔄 Sedang mempersiapkan WhatsApp Web...

💡 *Pastikan:*
• WhatsApp aktif di ponsel dengan nomor ${phoneNumber}
• Koneksi internet stabil
• Jangan tutup WhatsApp selama proses
• Proses akan berjalan hingga selesai tanpa timeout
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
        let extractionStarted = false;
        let lastProgressUpdate = Date.now();
        
        // Handle stdout
        extractorProcess.stdout.on('data', async (data) => {
            const output = data.toString();
            outputBuffer += output;
            
            console.log(`[EXTRACT-${userInfo.id}-${phoneNumber}] STDOUT:`, output);
            
            // Update last activity time
            lastProgressUpdate = Date.now();
            
            // Check for pairing code
            if (output.includes('KODE PAIRING ANDA:') && !pairingCodeSent) {
                const codeMatch = output.match(/KODE PAIRING ANDA:\s*(\w+)/);
                if (codeMatch) {
                    const pairingCode = codeMatch[1];
                    pairingCodeSent = true;
                    
                    processInfo.stage = 'Menunggu pairing code...';
                    
                    await bot.sendMessage(chatId, `
🔗 *Kode Pairing WhatsApp*

🔑 **${pairingCode}**

📋 *Langkah-langkah pairing:*
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
            if (output.includes('Login berhasil') && !extractionStarted) {
                extractionStarted = true;
                processInfo.stage = 'Mengekstrak grup...';
                await bot.sendMessage(chatId, `
✅ *WhatsApp Berhasil Terhubung!*

📱 Nomor ${phoneNumber} telah terhubung
🔄 Sedang mengekstrak semua grup WhatsApp...

⏳ Proses ini dapat memakan waktu lama untuk grup dalam jumlah besar.
📊 Bot akan memberikan update progress secara berkala.

🚫 **Tidak ada timeout** - proses akan berjalan hingga selesai.
                `, { parse_mode: 'Markdown' });
            }
            
            // Check for progress updates
            if (output.includes('Progress:') || output.includes('Grup ke-') || output.includes('Total grup:')) {
                // Send progress update every 2 minutes
                if (Date.now() - lastProgressUpdate > 120000) { // 2 minutes
                    processInfo.stage = 'Mengekstrak grup (dalam progress)...';
                    const duration = Math.floor((Date.now() - processInfo.startTime) / 1000 / 60);
                    
                    await bot.sendMessage(chatId, `
📊 *Update Progress Ekstraksi*

📱 Nomor: ${phoneNumber}
⏱️ Durasi: ${duration} menit
🔄 Status: Sedang mengekstrak grup...

💪 Proses masih berjalan, mohon bersabar untuk grup dalam jumlah besar.
                    `, { parse_mode: 'Markdown' });
                    
                    lastProgressUpdate = Date.now();
                }
            }
            
            // Check for completion
            if (output.includes('Ekstraksi selesai')) {
                processInfo.stage = 'Menyelesaikan...';
                await bot.sendMessage(chatId, '🏁 Ekstraksi selesai! Sedang mempersiapkan hasil...');
            }
        });
        
        // Handle stderr
        extractorProcess.stderr.on('data', (data) => {
            const error = data.toString();
            errorBuffer += error;
            console.error(`[EXTRACT-${userInfo.id}-${phoneNumber}] STDERR:`, error);
            
            // Update last activity time even for errors
            lastProgressUpdate = Date.now();
        });
        
        // Handle process completion
        extractorProcess.on('close', async (code) => {
            console.log(`[EXTRACT-${userInfo.id}-${phoneNumber}] Process exited with code:`, code);
            
            // Clean up process tracking
            activeProcesses.delete(userInfo.id);
            
            if (code === 0) {
                // Process completed successfully
                await handleSuccessfulExtraction(chatId, userInfo, phoneNumber);
                
                // Clean up session setelah berhasil
                setTimeout(() => {
                    cleanupExtractionSession(phoneNumber);
                }, 5000); // 5 detik delay untuk memastikan file terkirim
                
                await logActivity('EXTRACTION_SUCCESS_WITH_CLEANUP', userInfo, `Phone: ${phoneNumber}`);
            } else {
                // Process failed - cleanup immediately
                cleanupExtractionSession(phoneNumber);
                
                await bot.sendMessage(chatId, `
❌ *Proses Ekstraksi Gagal*

📱 Nomor: ${phoneNumber}
💥 Terjadi kesalahan saat mengekstrak grup WhatsApp.

**Kemungkinan penyebab:**
• Kode pairing salah atau expired
• Nomor WhatsApp tidak sesuai atau tidak aktif
• Koneksi internet bermasalah
• WhatsApp Web timeout atau error internal

**File session telah dibersihkan otomatis.**

💡 **Solusi:**
• Pastikan menggunakan nomor WhatsApp yang benar
• Coba lagi dengan \`/extract ${phoneNumber}\`
• Pastikan WhatsApp aktif dan stabil di ponsel
                `, { parse_mode: 'Markdown' });
                
                await logActivity('EXTRACTION_FAILED_WITH_CLEANUP', userInfo, `Phone: ${phoneNumber}, Code: ${code}`);
            }
        });
        
        // Handle process error
        extractorProcess.on('error', async (error) => {
            console.error(`[EXTRACT-${userInfo.id}-${phoneNumber}] Process error:`, error);
            
            activeProcesses.delete(userInfo.id);
            
            // Clean up session on error
            cleanupExtractionSession(phoneNumber);
            
            await bot.sendMessage(chatId, `
❌ *Kesalahan Sistem*

Terjadi kesalahan saat memulai proses ekstraksi.
File session telah dibersihkan otomatis.

💡 Silakan coba lagi dengan \`/extract ${phoneNumber}\`
            `, { parse_mode: 'Markdown' });
            
            await logActivity('EXTRACTION_ERROR_WITH_CLEANUP', userInfo, `Phone: ${phoneNumber}, Error: ${error.message}`);
        });
        
        // HAPUS TIMEOUT - Tidak ada lagi timeout 10 menit
        // Proses akan berjalan hingga selesai atau dibatalkan manual
        
        // Opsional: Monitor untuk inactivity yang sangat lama (misalnya 2 jam tanpa output)
        const inactivityMonitor = setInterval(async () => {
            if (activeProcesses.has(userInfo.id)) {
                const timeSinceLastUpdate = Date.now() - lastProgressUpdate;
                
                // Jika tidak ada output selama 2 jam, beri peringatan tapi jangan kill
                if (timeSinceLastUpdate > 2 * 60 * 60 * 1000) { // 2 hours
                    const duration = Math.floor((Date.now() - processInfo.startTime) / 1000 / 60);
                    
                    await bot.sendMessage(chatId, `
⚠️ *Peringatan Inactivity*

📱 Nomor: ${phoneNumber}
⏱️ Durasi: ${duration} menit
⏰ Tidak ada output selama 2 jam

🔄 Proses masih berjalan di background.
🚫 Gunakan /cancel jika ingin menghentikan manual.

💡 Untuk grup sangat banyak, proses bisa memakan waktu sangat lama.
                    `, { parse_mode: 'Markdown' });
                    
                    // Reset timer
                    lastProgressUpdate = Date.now();
                }
            } else {
                // Process sudah selesai, hentikan monitor
                clearInterval(inactivityMonitor);
            }
        }, 30 * 60 * 1000); // Check every 30 minutes
        
    } catch (error) {
        console.error('Error starting extraction process:', error);
        activeProcesses.delete(userInfo.id);
        
        // Clean up on startup error
        cleanupExtractionSession(phoneNumber);
        
        await bot.sendMessage(chatId, `
❌ *Gagal Memulai Proses*

Terjadi kesalahan saat memulai ekstraksi untuk nomor ${phoneNumber}.
File session telah dibersihkan otomatis.

💡 Silakan coba lagi dengan \`/extract ${phoneNumber}\`
        `, { parse_mode: 'Markdown' });
        
        await logActivity('EXTRACTION_START_ERROR_WITH_CLEANUP', userInfo, `Phone: ${phoneNumber}, Error: ${error.message}`);
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
        
        // Calculate extraction duration
        const duration = Math.floor((Date.now() - Date.now()) / 1000 / 60); // Placeholder - should be calculated from process start
        
        // Send summary message
        const totalGroups = resultData.groups ? resultData.groups.length : 0;
        const successfulLinks = resultData.groups ? resultData.groups.filter(g => g.link && g.link.startsWith('https://')).length : 0;
        const failedLinks = totalGroups - successfulLinks;
        
        await bot.sendMessage(chatId, `
✅ *Ekstraksi Berhasil Selesai!*

📱 **Nomor:** ${phoneNumber}
👤 **Akun:** ${resultData.metadata?.user_name || 'N/A'}

📊 **Ringkasan Hasil:**
🔢 Total grup: **${totalGroups}**
✅ Link berhasil: **${successfulLinks}**
❌ Link gagal: **${failedLinks}**

📁 Mengirim file hasil ekstraksi...
🗂️ Session files akan dibersihkan otomatis setelah pengiriman

⏱️ **Waktu ekstraksi:** ${new Date().toLocaleString('id-ID')}
        `, { parse_mode: 'Markdown' });
        
        // Send the result file
        await bot.sendDocument(chatId, filePath, {
            caption: `📋 **Hasil Ekstraksi Grup WhatsApp**\n\n📱 Nomor: ${phoneNumber}\n🔢 Total grup: ${totalGroups}\n✅ Link berhasil: ${successfulLinks}\n🕐 ${new Date().toLocaleString('id-ID')}`
        });
        
        // Send additional info for failed links
        if (failedLinks > 0) {
            await bot.sendMessage(chatId, `
ℹ️ **Informasi Link yang Gagal:**

${failedLinks} grup tidak dapat diambil linknya, kemungkinan karena:
• Anda bukan admin di grup tersebut
• Grup tidak mengizinkan invite link
• Grup sudah tidak aktif atau dihapus

💡 Hanya admin grup yang dapat mengambil invite link.
            `, { parse_mode: 'Markdown' });
        }
        
        // Final cleanup confirmation
        await bot.sendMessage(chatId, `
🧹 **Session Cleanup**

📱 Nomor: ${phoneNumber}
✅ File hasil telah dikirim
🗂️ Session files sedang dibersihkan...

🔒 **Keamanan:** Semua file session dan auth akan dihapus otomatis untuk keamanan.

💡 Gunakan \`/extract [nomor]\` untuk ekstraksi baru.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('EXTRACTION_SUCCESS_DETAILED', userInfo, `Phone: ${phoneNumber}, Groups: ${totalGroups}, Success: ${successfulLinks}, Failed: ${failedLinks}`);
        
    } catch (error) {
        console.error('Error handling successful extraction:', error);
        
        // Still cleanup even if sending results failed
        setTimeout(() => {
            cleanupExtractionSession(phoneNumber);
        }, 2000);
        
        await bot.sendMessage(chatId, `
✅ **Proses Ekstraksi Selesai**

📱 Nomor: ${phoneNumber}

⚠️ Terjadi masalah saat memproses hasil, tetapi file mungkin sudah tersimpan.
🗂️ Session files akan dibersihkan otomatis.

💡 Silakan cek folder 'group' di server untuk file hasil ekstraksi.
        `, { parse_mode: 'Markdown' });
        
        await logActivity('EXTRACTION_RESULT_ERROR_WITH_CLEANUP', userInfo, `Phone: ${phoneNumber}, Error: ${error.message}`);
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
    
    // Kill all active extraction processes with cleanup
    for (const [userId, processInfo] of activeProcesses) {
        try {
            processInfo.process.kill('SIGTERM');
            console.log(`Killed extraction process for user ${userId} (phone: ${processInfo.phoneNumber})`);
            
            // Cleanup session on shutdown
            cleanupExtractionSession(processInfo.phoneNumber);
            console.log(`Cleaned up extraction session for phone: ${processInfo.phoneNumber}`);
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
            console.log(`Cleaned up autojoin session for user ${userId}, phone: ${sessionInfo.phoneNumber}`);
        } catch (error) {
            console.error(`Error killing autojoin session for user ${userId}:`, error);
        }
    }
    
    console.log('🧹 All sessions cleaned up');
    console.log('🔒 Bot shutdown complete');
    
    bot.stopPolling();
    process.exit(0);
});

console.log('🦾 Telegram Bot v2.4.1 started successfully!');
console.log('👤 Owner ID:', OWNER_ID);

// Load and display current admins
const currentAdmins = loadAdmins();
const regularAdmins = currentAdmins.filter(id => id !== OWNER_ID);
console.log(`👥 Current admins: ${regularAdmins.length > 0 ? regularAdmins.join(', ') : 'None (only owner)'}`);
console.log(`🔒 Total authorized users: ${currentAdmins.length} (including owner)`);

console.log('🤖 Bot is ready to receive commands...');
console.log('');
console.log('🆕 New in v2.4.1:');
console.log('   • Fixed autojoin report generation and session cleanup');
console.log('   • Improved TXT file delivery for successful join results');
console.log('   • Better session management and file cleanup');
console.log('   • Fixed bug where session closed before sending reports');
console.log('   • Enhanced error handling and user feedback');