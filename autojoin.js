const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Get phone number from command line arguments
const args = process.argv.slice(2);
const PHONE_NUMBER = args[0];
const TELEGRAM_CHAT_ID = args[1];

// Validate input
if (!PHONE_NUMBER || !TELEGRAM_CHAT_ID) {
    console.error('❌ PARAMETER TIDAK LENGKAP!');
    console.error('📋 Penggunaan: node autojoin.js [nomor_telepon] [telegram_chat_id]');
    process.exit(1);
}

// Validate phone number format
function validatePhoneNumber(phoneNumber) {
    const cleanNumber = phoneNumber.replace(/\D/g, '');
    
    if (cleanNumber.length < 10 || cleanNumber.length > 15) {
        console.error('❌ NOMOR TELEPON TIDAK VALID!');
        console.error('📝 Nomor telepon harus 10-15 digit');
        process.exit(1);
    }
    
    return cleanNumber;
}

const VALIDATED_PHONE_NUMBER = validatePhoneNumber(PHONE_NUMBER);

function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// Extract group ID from WhatsApp invite link
function extractGroupId(link) {
    const regex = /https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/;
    const match = link.match(regex);
    return match ? match[1] : null;
}

// Log to file for telegram bot to read
function logToTelegram(message, type = 'info') {
    const logEntry = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        message: message,
        type: type,
        timestamp: new Date().toISOString(),
        phone: VALIDATED_PHONE_NUMBER
    }) + '\n';
    
    fs.appendFileSync('autojoin_log.txt', logEntry);
}

// Read group links from file
function readGroupLinks() {
    const filePath = `autojoin_links_${VALIDATED_PHONE_NUMBER}_${TELEGRAM_CHAT_ID}.json`;
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error reading group links:', error);
    }
    return { links: [], last_updated: null };
}

// Save group links to file
function saveGroupLinks(links) {
    const filePath = `autojoin_links_${VALIDATED_PHONE_NUMBER}_${TELEGRAM_CHAT_ID}.json`;
    const data = {
        links: links,
        last_updated: new Date().toISOString(),
        phone_number: VALIDATED_PHONE_NUMBER,
        telegram_chat_id: TELEGRAM_CHAT_ID
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Join groups function
async function joinGroups(sock, groupLinks) {
    console.log(`🚀 Memulai proses join ${groupLinks.length} grup...`);
    logToTelegram(`🚀 Memulai proses join ${groupLinks.length} grup...`);
    
    const results = [];
    
    for (let i = 0; i < groupLinks.length; i++) {
        const link = groupLinks[i];
        const groupId = extractGroupId(link);
        
        if (!groupId) {
            console.log(`❌ Link tidak valid: ${link}`);
            results.push({
                link: link,
                status: 'invalid_link',
                error: 'Format link tidak valid'
            });
            continue;
        }
        
        console.log(`\n📱 Join grup ${i + 1}/${groupLinks.length}`);
        console.log(`🔗 Link: ${link}`);
        console.log(`🆔 Group ID: ${groupId}`);
        
        try {
            // Join group using invite code
            const response = await sock.groupAcceptInvite(groupId);
            console.log(`✅ Berhasil join grup: ${response}`);
            
            results.push({
                link: link,
                status: 'success',
                group_jid: response,
                joined_at: new Date().toISOString()
            });
            
            // Random delay between 0-1 second
            const delay = Math.random() * 1000;
            console.log(`⏳ Delay ${Math.round(delay)}ms sebelum grup berikutnya...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            
        } catch (error) {
            console.log(`❌ Gagal join grup: ${error.message}`);
            
            let status = 'error';
            if (error.message.includes('already-participant')) {
                status = 'already_member';
            } else if (error.message.includes('not-authorized') || error.message.includes('forbidden')) {
                status = 'not_authorized';
            } else if (error.message.includes('item-not-found')) {
                status = 'link_expired';
            }
            
            results.push({
                link: link,
                status: status,
                error: error.message
            });
            
            // Still delay even on error
            const delay = Math.random() * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    // Generate report
    const successful = results.filter(r => r.status === 'success');
    const failed = results.filter(r => r.status !== 'success');
    const alreadyMember = results.filter(r => r.status === 'already_member');
    
    console.log(`\n📊 RINGKASAN HASIL:`);
    console.log(`   ✅ Berhasil join: ${successful.length}`);
    console.log(`   👥 Sudah member: ${alreadyMember.length}`);
    console.log(`   ❌ Gagal: ${failed.length}`);
    console.log(`   📱 Total diproses: ${results.length}`);
    
    // Save results
    const reportData = {
        metadata: {
            phone_number: VALIDATED_PHONE_NUMBER,
            telegram_chat_id: TELEGRAM_CHAT_ID,
            processed_at: new Date().toISOString(),
            total_links: groupLinks.length,
            successful_joins: successful.length,
            already_member: alreadyMember.length,
            failed_joins: failed.length
        },
        results: results
    };
    
    const reportPath = `autojoin_report_${VALIDATED_PHONE_NUMBER}_${Date.now()}.json`;
    fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
    console.log(`📄 Laporan disimpan ke: ${reportPath}`);
    
    // Send summary to telegram
    logToTelegram(`📊 HASIL AUTO JOIN:\n✅ Berhasil: ${successful.length}\n👥 Sudah member: ${alreadyMember.length}\n❌ Gagal: ${failed.length}\n📊 Total: ${results.length}`, 'result');
    
    return results;
}

// Main function
async function startAutoJoin() {
    try {
        const { version } = await fetchLatestBaileysVersion();
        console.log(`🚀 Menggunakan versi WhatsApp Web: ${version.join('.')}`);
        console.log(`📱 Target nomor: ${VALIDATED_PHONE_NUMBER}`);
        
        // Create unique auth directory for each phone number
        const authDir = `autojoin_auth_${VALIDATED_PHONE_NUMBER}`;
        ensureDirectoryExists(authDir);
        
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            defaultQueryTimeoutMs: 0,
            connectTimeoutMs: 60000,
            generateHighQualityLinkPreview: true
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Handle pairing code request
            if (qr) {
                console.log('📱 Memulai proses pairing code...');
                
                if (!sock.authState.creds.me) {
                    try {
                        console.log(`📤 Mengirim permintaan pairing code ke nomor: ${VALIDATED_PHONE_NUMBER}`);
                        const code = await sock.requestPairingCode(VALIDATED_PHONE_NUMBER);
                        console.log(`\n🔐 KODE PAIRING ANDA: ${code}`);
                        
                        // Log pairing code to telegram
                        logToTelegram(`🔐 Kode Pairing: ${code}`, 'pairing_code');
                        
                        console.log(`📱 Silakan masukkan kode ini di WhatsApp nomor: ${VALIDATED_PHONE_NUMBER}`);
                        console.log('⏳ Menunggu konfirmasi pairing...');
                    } catch (error) {
                        console.log('❌ Error requesting pairing code:', error.message);
                        logToTelegram(`❌ Error requesting pairing code: ${error.message}`, 'error');
                        process.exit(1);
                    }
                }
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut 
                    : true;
                    
                if (shouldReconnect) {
                    console.log('🔄 Koneksi terputus, mencoba reconnect...');
                    setTimeout(() => startAutoJoin(), 5000);
                } else {
                    console.log('❌ Koneksi ditutup. Anda telah logout.');
                    logToTelegram('❌ Koneksi ditutup. Session berakhir.', 'error');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                console.log('✅ Login berhasil dengan pairing code!');
                console.log(`👤 Akun: ${sock.user.name} (${sock.user.id})`);
                console.log(`📱 Nomor terhubung: ${VALIDATED_PHONE_NUMBER}`);
                
                logToTelegram('✅ WhatsApp berhasil terhubung! Silakan kirim link grup yang ingin dijoin.', 'connected');
                
                // Wait for links from telegram (this will be handled by the telegram bot)
                // The process will continue when startjoin command is received
                console.log('⏳ Menunggu perintah untuk memulai join grup...');
                
                // Set timeout for waiting links (10 minutes)
                setTimeout(() => {
                    console.log('⏰ Timeout menunggu link grup. Menutup session...');
                    logToTelegram('⏰ Timeout menunggu link grup. Session ditutup.', 'timeout');
                    sock.end();
                    process.exit(0);
                }, 10 * 60 * 1000);
                
            } else if (connection === 'connecting') {
                console.log(`🔗 Sedang menghubungkan untuk nomor: ${VALIDATED_PHONE_NUMBER}...`);
            }
        });
        
        // Handle messages (not needed for autojoin, but keeping for completeness)
        sock.ev.on('messages.upsert', async (m) => {
            // Auto join doesn't need to handle incoming messages
        });
        
        // Check for startjoin command file
        setInterval(async () => {
            const commandFile = `autojoin_command_${VALIDATED_PHONE_NUMBER}_${TELEGRAM_CHAT_ID}.txt`;
            if (fs.existsSync(commandFile)) {
                const command = fs.readFileSync(commandFile, 'utf8').trim();
                
                if (command === 'startjoin') {
                    console.log('🎯 Perintah startjoin diterima!');
                    
                    // Delete command file
                    fs.unlinkSync(commandFile);
                    
                    // Read group links
                    const linkData = readGroupLinks();
                    
                    if (linkData.links && linkData.links.length > 0) {
                        console.log(`📊 Akan join ${linkData.links.length} grup...`);
                        
                        // Start joining groups
                        const results = await joinGroups(sock, linkData.links);
                        
                        // Save final report
                        const finalReportPath = `autojoin_final_report_${VALIDATED_PHONE_NUMBER}_${Date.now()}.json`;
                        fs.writeFileSync(finalReportPath, JSON.stringify({
                            metadata: {
                                phone_number: VALIDATED_PHONE_NUMBER,
                                telegram_chat_id: TELEGRAM_CHAT_ID,
                                completed_at: new Date().toISOString(),
                                total_processed: linkData.links.length
                            },
                            results: results
                        }, null, 2));
                        
                        console.log('✅ Proses auto join selesai!');
                        logToTelegram(`✅ Auto join selesai! Report: ${finalReportPath}`, 'completed');
                        
                        // Logout and close
                        setTimeout(() => {
                            console.log('🔓 Logout dari WhatsApp...');
                            sock.logout();
                            process.exit(0);
                        }, 3000);
                        
                    } else {
                        console.log('❌ Tidak ada link grup untuk dijoin');
                        logToTelegram('❌ Tidak ada link grup untuk dijoin', 'error');
                        process.exit(1);
                    }
                }
            }
        }, 2000); // Check every 2 seconds
        
    } catch (error) {
        console.error('❌ Error saat memulai autojoin:', error.message);
        logToTelegram(`❌ Error: ${error.message}`, 'error');
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Proses dihentikan oleh user');
    logToTelegram('🛑 Proses auto join dibatalkan', 'cancelled');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
    logToTelegram(`❌ Uncaught Exception: ${error.message}`, 'error');
    process.exit(1);
});

// Start the autojoin process
console.log('🤖 WhatsApp Auto Join v1.0.0');
console.log(`📱 Nomor target: ${VALIDATED_PHONE_NUMBER}`);
console.log(`💬 Telegram Chat ID: ${TELEGRAM_CHAT_ID}`);
console.log('');
startAutoJoin();