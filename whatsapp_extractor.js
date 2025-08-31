const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Get phone number from command line arguments
const args = process.argv.slice(2);
const PHONE_NUMBER = args[0];

// Validate phone number input
if (!PHONE_NUMBER) {
    console.error('❌ NOMOR TELEPON TIDAK DISEDIAKAN!');
    console.error('📋 Penggunaan: node whatsapp_extractor.js [nomor_telepon]');
    console.error('📱 Contoh: node whatsapp_extractor.js 628123456789');
    process.exit(1);
}

// Validate phone number format
function validatePhoneNumber(phoneNumber) {
    const cleanNumber = phoneNumber.replace(/\D/g, '');
    
    if (cleanNumber.length < 10 || cleanNumber.length > 15) {
        console.error('❌ NOMOR TELEPON TIDAK VALID!');
        console.error('📏 Nomor telepon harus 10-15 digit');
        console.error('📱 Contoh format yang benar:');
        console.error('   • Indonesia: 628123456789');
        console.error('   • Malaysia: 60123456789');
        console.error('   • Singapura: 6512345678');
        process.exit(1);
    }
    
    return cleanNumber;
}

const VALIDATED_PHONE_NUMBER = validatePhoneNumber(PHONE_NUMBER);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function formatDate(timestamp) {
    const date = new Date(timestamp * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`📁 Folder '${dirPath}' telah dibuat`);
    }
}

function isGroup(jid) {
    return jid.endsWith('@g.us');
}

function getUniqueFileName(phoneNumber) {
    const baseDir = 'group';
    ensureDirectoryExists(baseDir);
    
    // Create filename with phone number and timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const baseFileName = `groups_${phoneNumber}_${timestamp}`;
    
    let counter = 1;
    let fileName = `${baseFileName}.json`;
    let filePath = path.join(baseDir, fileName);
    
    while (fs.existsSync(filePath)) {
        counter++;
        fileName = `${baseFileName}_${counter}.json`;
        filePath = path.join(baseDir, fileName);
    }
    
    return { fileName, filePath, counter };
}

function normalizeJid(jid) {
    if (!jid) return '';
    
    let normalized = jid.split(':')[0];
    
    if (normalized.includes('@')) {
        normalized = normalized.split('@')[0];
    }
    
    return normalized;
}

function getJidVariations(jid) {
    if (!jid) return [];
    
    const base = normalizeJid(jid); 
    const variations = new Set();
    
    variations.add(jid);
    variations.add(base);
    variations.add(`${base}@s.whatsapp.net`);
    
    for (let i = 0; i <= 20; i++) {
        variations.add(`${base}:${i}@s.whatsapp.net`);
    }
    
    variations.add(`${base}@lid`);
    for (let i = 0; i <= 20; i++) {
        variations.add(`${base}:${i}@lid`);
    }
    
    variations.add(`${base}@c.us`);
    for (let i = 0; i <= 5; i++) {
        variations.add(`${base}:${i}@c.us`);
    }
    
    return Array.from(variations);
}

async function checkAdminStatus(sock, groupJid, userJid) {
    console.log(`🔍 Checking admin status for: ${userJid}`);
    console.log(`   📋 Group: ${groupJid}`);
    
    const userBase = normalizeJid(userJid);
    console.log(`   📱 User base number: ${userBase}`);
    
    try {
        console.log(`   📥 Fetching fresh group metadata...`);
        const groupMetadata = await sock.groupMetadata(groupJid);
        console.log(`   ✅ Got ${groupMetadata.participants.length} participants from server`);
        
        console.log(`   📋 All participants with base numbers:`);
        const participantsWithBase = groupMetadata.participants.map((p, index) => {
            const baseNumber = normalizeJid(p.id);
            console.log(`      ${index + 1}. ${p.id} -> ${baseNumber} - ${p.admin || 'member'}`);
            return {
                ...p,
                baseNumber
            };
        });
        
        const matchedParticipant = participantsWithBase.find(p => p.baseNumber === userBase);
        
        if (matchedParticipant) {
            console.log(`   ✅ MATCH FOUND BY BASE NUMBER!`);
            console.log(`      User base: ${userBase}`);
            console.log(`      Participant: ${matchedParticipant.id} -> ${matchedParticipant.baseNumber}`);
            console.log(`      Admin status: ${matchedParticipant.admin || 'member'}`);
            
            return {
                isAdmin: matchedParticipant.admin === 'admin' || matchedParticipant.admin === 'superadmin',
                adminType: matchedParticipant.admin || 'member',
                matchedWith: `base_number: ${userBase}`,
                participantId: matchedParticipant.id
            };
        }
        
        if (groupMetadata.owner) {
            const ownerBase = normalizeJid(groupMetadata.owner);
            console.log(`   👑 Checking owner base: ${groupMetadata.owner} -> ${ownerBase}`);
            
            if (userBase === ownerBase) {
                console.log(`   ✅ USER IS OWNER BY BASE NUMBER!`);
                return {
                    isAdmin: true,
                    adminType: 'owner',
                    matchedWith: `owner_base: ${userBase}`,
                    participantId: groupMetadata.owner
                };
            }
        }
        
        console.log(`   🔄 Trying exact string matching as fallback...`);
        const exactMatch = groupMetadata.participants.find(p => p.id === userJid);
        if (exactMatch) {
            console.log(`   ✅ EXACT MATCH FOUND!`);
            return {
                isAdmin: exactMatch.admin === 'admin' || exactMatch.admin === 'superadmin',
                adminType: exactMatch.admin || 'member',
                matchedWith: `exact_match: ${userJid}`,
                participantId: exactMatch.id
            };
        }
        
        console.log(`   ❌ User not found after all attempts`);
        console.log(`   📊 Summary:`);
        console.log(`      - User base number: ${userBase}`);
        console.log(`      - Total participants: ${groupMetadata.participants.length}`);
        console.log(`      - Owner: ${groupMetadata.owner} -> ${normalizeJid(groupMetadata.owner || '')}`);
        
        return { 
            isAdmin: false, 
            adminType: 'not_found',
            matchedWith: 'none',
            participantId: null
        };
        
    } catch (error) {
        console.log(`   ⚠️  Error fetching group metadata: ${error.message}`);
        return { 
            isAdmin: false, 
            adminType: 'error',
            matchedWith: error.message,
            participantId: null
        };
    }
}

async function getGroupInviteLink(sock, jid, retryCount = 3) {
    for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
            console.log(`   🔗 Attempt ${attempt}/${retryCount}: Fetching invite code...`);
            const inviteCode = await sock.groupInviteCode(jid);
            const link = `https://chat.whatsapp.com/${inviteCode}`;
            console.log(`   ✅ Success on attempt ${attempt}: ${link}`);
            return { link, status: 'success', attempt };
        } catch (error) {
            console.log(`   ⚠️  Attempt ${attempt} failed: ${error.message}`);
            
            if (attempt < retryCount) {
                console.log(`   ⏳ Waiting 2 seconds before retry...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                let status = 'error';
                if (error.message.includes('not-authorized') || 
                    error.message.includes('forbidden') || 
                    error.message.includes('not allowed')) {
                    status = 'not_admin';
                } else if (error.message.includes('item-not-found') || 
                          error.message.includes('group-not-found')) {
                    status = 'group_not_found';
                } else {
                    status = `error: ${error.message}`;
                }
                
                return { link: 'ERROR', status, attempt };
            }
        }
    }
}

async function extractAllGroups(sock) {
    try {
        console.log('📋 Mengambil data semua grup...');
        console.log(`👤 User JID: ${sock.user.id}`);
        console.log(`👤 User Name: ${sock.user.name}`);
        console.log(`📱 Phone Number: ${VALIDATED_PHONE_NUMBER}`);
        
        const groups = await sock.groupFetchAllParticipating();
        const groupList = [];
        let groupCount = 0;
        let communityCount = 0;
        
        console.log(`📊 Ditemukan ${Object.keys(groups).length} item (grup + komunitas)`);
        
        for (const [jid, group] of Object.entries(groups)) {
            if (!isGroup(jid)) {
                communityCount++;
                console.log(`🚫 Melewati komunitas: ${group.subject || 'Tanpa nama'}`);
                continue;
            }
            
            groupCount++;
            console.log(`\n📁 Memproses grup ${groupCount}: ${group.subject || 'Tanpa nama'}`);
            console.log(`   📋 JID: ${jid}`);
            
            // Cek status admin dengan fungsi yang diperbaiki
            const adminCheck = await checkAdminStatus(sock, jid, sock.user.id);
            console.log(`   🔍 Admin check result:`, adminCheck);
            
            // Selalu coba ambil link grup, terlepas dari deteksi admin
            console.log(`   🔗 Attempting to get group link...`);
            const linkResult = await getGroupInviteLink(sock, jid, 2);
            
            let finalLink = "TIDAK DAPAT DIAMBIL";
            let finalStatus = linkResult.status;
            
            if (linkResult.status === 'success') {
                finalLink = linkResult.link;
            } else if (linkResult.status === 'not_admin') {
                finalLink = "BUKAN ADMIN";
            } else {
                finalLink = "ERROR_MENGAMBIL_LINK";
            }
            
            // Ambil metadata grup terbaru untuk data yang akurat
            let freshMetadata = null;
            try {
                freshMetadata = await sock.groupMetadata(jid);
            } catch (error) {
                console.log(`   ⚠️  Could not fetch fresh metadata: ${error.message}`);
            }
            
            const groupData = {
                id: jid,
                name: group.subject || "Tanpa nama",
                participants: freshMetadata ? freshMetadata.participants.length : group.participants.length,
                creation: group.creation || 0,
                creation_date: group.creation ? formatDate(group.creation) : "Tidak diketahui",
                owner: group.owner || (freshMetadata ? freshMetadata.owner : "Tidak diketahui"),
                desc: group.desc || (freshMetadata ? freshMetadata.desc : "Tidak ada deskripsi"),
                link: finalLink,
                link_status: finalStatus,
                admin_status: adminCheck.adminType.toUpperCase(),
                is_admin: adminCheck.isAdmin,
                debug_info: {
                    user_jid: sock.user.id,
                    phone_number: VALIDATED_PHONE_NUMBER,
                    owner_jid: group.owner || (freshMetadata ? freshMetadata.owner : null),
                    participants_count: freshMetadata ? freshMetadata.participants.length : group.participants.length,
                    admin_detection_method: adminCheck.matchedWith,
                    matched_participant: adminCheck.participantId,
                    link_attempts: linkResult.attempt || 0
                }
            };
            
            groupList.push(groupData);
            
            // Delay antara grup untuk menghindari rate limit
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Generate nama file dan simpan dengan nomor telepon
        const { fileName, filePath, counter } = getUniqueFileName(VALIDATED_PHONE_NUMBER);
        
        // Format sederhana hanya nama dan link
        const simpleGroupList = groupList.map(group => ({
            name: group.name,
            link: group.link
        }));
        
        const outputData = {
            metadata: {
                extracted_at: new Date().toISOString(),
                extracted_date: formatDate(Math.floor(Date.now() / 1000)),
                phone_number: VALIDATED_PHONE_NUMBER,
                total_groups: groupList.length,
                run_number: counter,
                user_name: sock.user.name,
                extractor_version: "2.2.0-dynamic-phone"
            },
            groups: simpleGroupList
        };
        
        fs.writeFileSync(filePath, JSON.stringify(outputData, null, 2), 'utf8');
        
        // Laporan hasil - Format Console yang Sederhana
        const successLinks = groupList.filter(g => g.link.startsWith('https://'));
        const failedLinks = groupList.filter(g => !g.link.startsWith('https://'));
        
        console.log(`\n📈 RINGKASAN EKSTRAKSI:`);
        console.log(`   📱 Nomor: ${VALIDATED_PHONE_NUMBER}`);
        console.log(`   📁 File: ${fileName}`);
        console.log(`   👥 Total grup: ${groupList.length}`);
        console.log(`   ✅ Link berhasil: ${successLinks.length}`);
        console.log(`   ❌ Link gagal: ${failedLinks.length}`);
        console.log(`✅ Berhasil menyimpan ke: ${filePath}`);
        
        if (successLinks.length > 0) {
            console.log(`\n🔗 GRUP DENGAN LINK BERHASIL:`);
            successLinks.forEach((g, index) => {
                console.log(`   ${index + 1}. ${g.name}`);
                console.log(`      ${g.link}`);
            });
        }
        
        if (failedLinks.length > 0) {
            console.log(`\n❌ GRUP YANG GAGAL DIAMBIL LINKNYA:`);
            failedLinks.forEach((g, index) => {
                console.log(`   ${index + 1}. ${g.name} - ${g.link}`);
            });
        }
        
        setTimeout(() => {
            console.log('\n📚 Ekstraksi selesai, menutup koneksi...');
            rl.close();
            sock.end();
            process.exit(0);
        }, 2000);
        
    } catch (error) {
        console.error('❌ Error saat ekstrak grup:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Fungsi untuk menangani pairing code
async function handlePairingCode(sock) {
    return new Promise((resolve) => {
        console.log('\n🔔 NOTIFIKASI: Pairing code diperlukan!');
        console.log(`📱 Silakan cek notifikasi di ponsel dengan nomor: ${VALIDATED_PHONE_NUMBER}`);
        console.log('⚡ Kode pairing akan muncul sebagai notifikasi');
        console.log('');
        
        rl.question('🔑 Masukkan kode pairing (8 digit): ', (pairingCode) => {
            if (pairingCode && pairingCode.length === 8) {
                console.log(`✅ Menggunakan kode pairing: ${pairingCode}`);
                resolve(pairingCode);
            } else {
                console.log('❌ Kode pairing tidak valid! Harus 8 digit.');
                console.log('🔄 Silakan restart script dan coba lagi.');
                process.exit(1);
            }
        });
    });
}

// Fungsi utama untuk menjalankan bot dengan pairing code
async function startBot() {
    try {
        const { version } = await fetchLatestBaileysVersion();
        console.log(`🚀 Menggunakan versi WhatsApp Web: ${version.join('.')}`);
        console.log(`📱 Target nomor: ${VALIDATED_PHONE_NUMBER}`);
        
        // Create unique auth directory for each phone number
        const authDir = `auth_${VALIDATED_PHONE_NUMBER}`;
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
            const { connection, lastDisconnect, qr, isNewLogin } = update;
            
            // Handle pairing code request
            if (qr) {
                console.log('📱 Memulai proses pairing code...');
                
                // Use the phone number from command line argument
                if (!sock.authState.creds.me) {
                    try {
                        console.log(`📤 Mengirim permintaan pairing code ke nomor: ${VALIDATED_PHONE_NUMBER}`);
                        const code = await sock.requestPairingCode(VALIDATED_PHONE_NUMBER);
                        console.log(`\n🔔 KODE PAIRING ANDA: ${code}`);
                        console.log(`📱 Silakan masukkan kode ini di WhatsApp nomor: ${VALIDATED_PHONE_NUMBER}`);
                        console.log('   1. Buka WhatsApp di ponsel');
                        console.log('   2. Tap Menu (3 titik) > Perangkat Tertaut');
                        console.log('   3. Tap "Tautkan Perangkat"');
                        console.log('   4. Tap "Tautkan dengan nomor telepon"');
                        console.log(`   5. Masukkan kode: ${code}`);
                        console.log('\n⏳ Menunggu konfirmasi pairing...');
                    } catch (error) {
                        console.log('❌ Error requesting pairing code:', error.message);
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
                    setTimeout(() => startBot(), 5000);
                } else {
                    console.log('❌ Koneksi ditutus. Anda telah logout.');
                    rl.close();
                    process.exit(1);
                }
            } else if (connection === 'open') {
                console.log('✅ Login berhasil dengan pairing code!');
                console.log(`👤 Akun: ${sock.user.name} (${sock.user.id})`);
                console.log(`📱 Nomor terhubung: ${VALIDATED_PHONE_NUMBER}`);
                
                if (isNewLogin) {
                    console.log('🎉 Ini adalah login pertama dengan pairing code!');
                }
                
                console.log('⏳ Menunggu 5 detik sebelum memulai ekstraksi...');
                setTimeout(() => {
                    extractAllGroups(sock);
                }, 5000);
            } else if (connection === 'connecting') {
                console.log(`🔗 Sedang menghubungkan untuk nomor: ${VALIDATED_PHONE_NUMBER}...`);
            }
        });
        
    } catch (error) {
        console.error('❌ Error saat memulai bot:', error.message);
        rl.close();
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Proses dihentikan oleh user');
    rl.close();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
    rl.close();
    process.exit(1);
});

// Jalankan bot
console.log('🤖 WhatsApp Group Extractor v2.2.0 - Dynamic Phone Number Edition');
console.log('🔧 Fitur Utama:');
console.log('   • Login menggunakan pairing code (bukan QR code)');
console.log('   • Nomor telepon dinamis dari parameter command line');
console.log('   • Auth session terpisah per nomor telepon');
console.log('   • Algoritma deteksi admin yang telah diperbaiki');
console.log('   • Support untuk semua format JID WhatsApp');
console.log('');
console.log('📋 Cara penggunaan:');
console.log('   node whatsapp_extractor.js [nomor_telepon]');
console.log(`📱 Nomor yang akan digunakan: ${VALIDATED_PHONE_NUMBER}`);
console.log('');
startBot();