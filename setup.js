const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt) {
    return new Promise((resolve) => {
        rl.question(prompt, resolve);
    });
}

async function setup() {
    console.log('🚀 Setup WhatsApp Telegram Extractor Bot\n');
    
    // Check if .env already exists
    if (fs.existsSync('.env')) {
        const overwrite = await question('❓ File .env sudah ada. Timpa? (y/n): ');
        if (overwrite.toLowerCase() !== 'y') {
            console.log('✅ Setup dibatalkan.');
            rl.close();
            return;
        }
    }
    
    console.log('📝 Silakan isi konfigurasi berikut:\n');
    
    // Get Telegram Bot Token
    console.log('🤖 TELEGRAM BOT TOKEN:');
    console.log('   1. Buka @BotFather di Telegram');
    console.log('   2. Kirim /newbot');
    console.log('   3. Ikuti instruksi untuk membuat bot');
    console.log('   4. Salin token yang diberikan\n');
    
    const botToken = await question('🔑 Masukkan Telegram Bot Token: ');
    
    if (!botToken || botToken.length < 10) {
        console.log('❌ Token tidak valid!');
        rl.close();
        return;
    }
    
    // Get Admin User IDs
    console.log('\n👥 ADMIN USER IDs:');
    console.log('   1. Kirim pesan ke @userinfobot di Telegram');
    console.log('   2. Salin User ID yang muncul');
    console.log('   3. Jika ada beberapa admin, pisahkan dengan koma\n');
    
    const adminIds = await question('👤 Masukkan Admin User ID(s): ');
    
    if (!adminIds || adminIds.length < 5) {
        console.log('❌ Admin User ID tidak valid!');
        rl.close();
        return;
    }
    
    // Validate admin IDs
    const adminArray = adminIds.split(',').map(id => id.trim());
    const validIds = adminArray.every(id => /^\d+$/.test(id));
    
    if (!validIds) {
        console.log('❌ Format Admin User ID tidak valid! Harus berupa angka.');
        rl.close();
        return;
    }
    
    // Create .env file
    const envContent = `# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=${botToken}

# Admin User IDs (comma separated)
ADMIN_USER_IDS=${adminIds}
`;
    
    try {
        fs.writeFileSync('.env', envContent);
        console.log('\n✅ File .env berhasil dibuat!');
        
        // Create necessary directories
        const dirs = ['auth', 'group'];
        dirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir);
                console.log(`📁 Folder '${dir}' dibuat`);
            }
        });
        
        // Check if WhatsApp extractor exists
        if (!fs.existsSync('whatsapp_extractor.js')) {
            console.log('\n⚠️  File whatsapp_extractor.js tidak ditemukan!');
            console.log('   Pastikan Anda sudah menyalin kode WhatsApp extractor ke file tersebut.');
        }
        
        console.log('\n🎉 Setup selesai!');
        console.log('\n📋 Langkah selanjutnya:');
        console.log('   1. npm install');
        console.log('   2. Pastikan file whatsapp_extractor.js sudah ada');
        console.log('   3. npm start');
        console.log('\n💡 Bot siap digunakan dengan perintah /start di Telegram!');
        
    } catch (error) {
        console.log('❌ Error membuat file .env:', error.message);
    }
    
    rl.close();
}

setup().catch(error => {
    console.error('❌ Error during setup:', error);
    rl.close();
});