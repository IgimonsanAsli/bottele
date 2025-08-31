const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Get phone number from command line argument or environment
const PHONE_NUMBER = process.argv[2] || process.env.PHONE_NUMBER || "6289519705542";

// Validate phone number
if (!PHONE_NUMBER || PHONE_NUMBER.length < 10) {
    console.error('❌ NOMOR TELEPON TIDAK VALID!');
    console.error('📝 Format: node whatsapp_extractor.js 628123456789');
    process.exit(1);
}

console.log(`✅ Menggunakan nomor: ${PHONE_NUMBER}`);

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

function getUniqueFileName() {
    const baseDir = 'group';
    ensureDirectoryExists(baseDir);
    
    let counter = 1;
    let fileName = `listgroup.json`;
    let filePath = path.join(baseDir, fileName);
    
    while (fs.existsSync(filePath)) {
        counter++;
        fileName = `listgroup_${counter}.json`;
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
        console.log('🔍 Mengambil data semua grup...');
        console.log(`👤 User JID: ${sock.user.id}`);
        console.log(`👤 User Name: ${sock.user.name}`);
        
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
            console.log(`\n📝 Memproses grup ${groupCount}: ${group.subject || 'Tanpa nama'}`);
            console.log(`   📋 JID: ${jid}`);
            
            const adminCheck = await checkAdminStatus(sock, jid, sock.user.id);
            console.log(`   🔐 Admin check result:`, adminCheck);
            
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
                    owner_jid: group.owner || (freshMetadata ? freshMetadata.owner : null),
                    participants_count: freshMetadata ? freshMetadata.participants.length : group.participants.length,
                    admin_detection_method: adminCheck.matchedWith,
                    matched_participant: adminCheck.participantId,
                    link_attempts: linkResult.attempt || 0
                }
            };
            
            groupList.push(groupData);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        const { fileName, filePath, counter } = getUniqueFileName();
        
        const simpleGroupList = groupList.map(group => ({
            name: group.name,
            link: group.link
        }));
        
        const outputData = {
            metadata: {
                extracted_at: new Date().toISOString(),
                extracted_date: formatDate(Math.floor(Date.now() / 1000)),
                total_groups: groupList.length,
                run_number: counter,
                user_name: sock.user.name,
                phone_number: PHONE_NUMBER,
                extractor_version: "2.1.1-telegram-bot"
            },
            groups: simpleGroupList
        };
        
        fs.writeFileSync(filePath, JSON.stringify(outputData, null, 2), 'utf8');
        
        const successLinks = groupList.filter(g => g.link.startsWith('https://'));
        const failedLinks = groupList.filter(g => !g.link.startsWith('https://'));
        
        console.log(`\n📈 RINGKASAN EKSTRAKSI:`);
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
        
        console.log('\n🔚 Ekstraksi selesai, menutup koneksi...');
        
        setTimeout(() => {
            sock.end();
            process.exit(0);
        }, 2000);
        
    } catch (error) {
        console.error('❌ Error saat ekstrak grup:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

function validatePhoneNumber(phoneNumber) {
    if (!phoneNumber || phoneNumber.length < 10) {
        console.log('❌ NOMOR TELEPON TIDAK VALID!');
        console.log('📝 Format yang benar:');
        console.log('   • Indonesia: 6281234567890');
        console.log('   • Malaysia: 60123456789');
        console.log('   • Singapore: 6512345678');
        process.exit(1);
    }
    
    console.log(`✅ Menggunakan nomor: ${phoneNumber}`);
    return true;
}

async function startBot() {
    try {
        const { version } = await fetchLatestBaileysVersion();
        console.log(`🚀 Menggunakan versi WhatsApp Web: ${version.join('.')}`);
        
        // Create unique auth directory for this session
        const authDir = `auth_${PHONE_NUMBER}_${Date.now()}`;
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
            
            if (qr) {
                console.log('📱 Memulai proses pairing code...');
                
                if (!sock.authState.creds.me) {
                    validatePhoneNumber(PHONE_NUMBER);
                    
                    try {
                        console.log('📤 Mengirim permintaan pairing code...');
                        const code = await sock.requestPairingCode(PHONE_NUMBER);
                        console.log(`\n🔔 KODE PAIRING ANDA: ${code}`);
                        console.log('📱 Silakan masukkan kode ini di WhatsApp Anda:');
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
                    console.log('❌ Koneksi ditutup. Anda telah logout.');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                console.log('✅ Login berhasil dengan pairing code!');
                console.log(`👤 Akun: ${sock.user.name} (${sock.user.id})`);
                
                if (isNewLogin) {
                    console.log('🎉 Ini adalah login pertama dengan pairing code!');
                }
                
                console.log('⏳ Menunggu 5 detik sebelum memulai ekstraksi...');
                setTimeout(() => {
                    extractAllGroups(sock);
                }, 5000);
            } else if (connection === 'connecting') {
                console.log('🔗 Sedang menghubungkan...');
            }
        });
        
        // Clean up auth directory after completion
        process.on('exit', () => {
            try {
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true });
                }
            } catch (error) {
                console.error('Error cleaning up auth directory:', error);
            }
        });
        
    } catch (error) {
        console.error('❌ Error saat memulai bot:', error.message);
        process.exit(1);
    }
}

process.on('SIGINT', () => {
    console.log('\n🛑 Proses dihentikan oleh user');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
    process.exit(1);
});

console.log('🤖 WhatsApp Group Extractor v2.1.1 - Telegram Bot Edition');
console.log('🔧 Fitur:');
console.log('   • Mendukung parameter nomor telepon');
console.log('   • Login menggunakan pairing code otomatis');
console.log('   • Clean up session otomatis');
console.log('   • Optimized untuk integrasi bot Telegram');
console.log('   • Support multiple concurrent sessions');
console.log('');
console.log('📋 Cara penggunaan:');
console.log('   node whatsapp_extractor.js [nomor_telepon]');
console.log(`   Contoh: node whatsapp_extractor.js ${PHONE_NUMBER}`);
console.log('');
startBot();