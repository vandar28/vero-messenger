const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

class DatabaseBackup {
  constructor() {
    this.dbPath = path.join(__dirname, 'database.sqlite');
    this.backupDir = path.join(__dirname, 'backups');
    this.maxBackups = 16;
    
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
    
    console.log('📁 Папка для бэкапов создана');
    console.log(`📦 Максимум бэкапов: ${this.maxBackups}`);
  }

  validateBackup(filePath) {
    try {
      if (!fs.existsSync(filePath)) return false;
      
      const stats = fs.statSync(filePath);
      if (stats.size < 100) {
        console.log(`⚠️ Бэкап ${path.basename(filePath)} слишком маленький (${stats.size} байт)`);
        return false;
      }
      
      const compressed = fs.readFileSync(filePath);
      const data = zlib.gunzipSync(compressed);
      
      const header = data.slice(0, 16).toString('hex');
      if (!header.startsWith('53514c69746520666f726d6174')) {
        console.log(`⚠️ Бэкап ${path.basename(filePath)} поврежден (не SQLite)`);
        return false;
      }
      
      const str = data.toString('utf8', 0, Math.min(data.length, 10000));
      if (!str.includes('CREATE TABLE') && !str.includes('users')) {
        console.log(`⚠️ Бэкап ${path.basename(filePath)} не содержит таблиц`);
        return false;
      }
      
      console.log(`✅ Бэкап ${path.basename(filePath)} валидный (${(data.length / 1024).toFixed(2)} KB)`);
      return true;
    } catch (error) {
      console.log(`❌ Ошибка проверки бэкапа ${path.basename(filePath)}:`, error.message);
      return false;
    }
  }

  downloadBackupFromGitHub() {
    const repo = 'vandar28/vero-messenger';
    const url = `https://api.github.com/repos/${repo}/contents/backups/latest.sqlite.gz`;
    
    console.log('📥 Попытка скачать бэкап из GitHub...');
    
    return new Promise((resolve) => {
      const options = {
        headers: {
          'User-Agent': 'Node.js',
          'Accept': 'application/vnd.github.v3+json'
        }
      };
      
      const token = process.env.GITHUB_TOKEN || '';
      if (token) {
        options.headers['Authorization'] = `token ${token}`;
      }
      
      https.get(url, options, (response) => {
        if (response.statusCode === 404) {
          console.log('ℹ️ Бэкап не найден на GitHub');
          resolve(null);
          return;
        }
        
        if (response.statusCode !== 200) {
          console.log(`⚠️ Ошибка GitHub API: ${response.statusCode}`);
          resolve(null);
          return;
        }
        
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            const json = JSON.parse(data);
            const buffer = Buffer.from(json.content, 'base64');
            
            try {
              const test = zlib.gunzipSync(buffer);
              const header = test.slice(0, 16).toString('hex');
              if (header.startsWith('53514c69746520666f726d6174')) {
                console.log(`✅ Бэкап скачан с GitHub! Размер: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
                resolve(buffer);
              } else {
                console.log('⚠️ Бэкап с GitHub поврежден');
                resolve(null);
              }
            } catch (e) {
              console.log('⚠️ Бэкап с GitHub поврежден (не gzip)');
              resolve(null);
            }
          } catch (e) {
            console.error('❌ Ошибка парсинга ответа:', e);
            resolve(null);
          }
        });
      }).on('error', (e) => {
        console.error('❌ Ошибка загрузки:', e);
        resolve(null);
      });
    });
  }

  async restoreFromBackup() {
    console.log('\n🔄 ПРОВЕРКА БЭКАПОВ...');
    
    // 1. Сначала пробуем GitHub
    try {
      const githubData = await this.downloadBackupFromGitHub();
      if (githubData) {
        try {
          const decompressed = zlib.gunzipSync(githubData);
          fs.writeFileSync(this.dbPath, decompressed);
          console.log(`✅ БД восстановлена из GitHub! Размер: ${(decompressed.length / 1024 / 1024).toFixed(2)} MB`);
          return true;
        } catch (e) {
          console.log('⚠️ Ошибка распаковки GitHub бэкапа:', e.message);
        }
      }
    } catch (e) {
      console.log('⚠️ Ошибка загрузки из GitHub:', e.message);
    }
    
    // 2. Пробуем локальный бэкап
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite.gz'))
        .sort();
      
      let latest = null;
      for (let i = files.length - 1; i >= 0; i--) {
        const filePath = path.join(this.backupDir, files[i]);
        if (this.validateBackup(filePath)) {
          latest = files[i];
          break;
        }
      }
      
      if (latest) {
        const backupPath = path.join(this.backupDir, latest);
        console.log(`📥 Восстановление из локального бэкапа: ${latest}`);
        
        const compressed = fs.readFileSync(backupPath);
        const data = zlib.gunzipSync(compressed);
        
        fs.writeFileSync(this.dbPath, data);
        console.log(`✅ БД восстановлена из локального бэкапа! Размер: ${(data.length / 1024 / 1024).toFixed(2)} MB`);
        return true;
      }
    } catch (e) {
      console.log('⚠️ Ошибка локального бэкапа:', e.message);
    }
    
    console.log('⚠️ Нет валидных бэкапов для восстановления');
    return false;
  }

  createBackup() {
    if (!fs.existsSync(this.dbPath)) {
      console.log('❌ База данных не найдена');
      return null;
    }

    const stats = fs.statSync(this.dbPath);
    if (stats.size < 100) {
      console.log('⚠️ БД слишком маленькая, пропускаем бэкап');
      return null;
    }

    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`📊 Текущий размер БД: ${sizeMB} MB`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}.sqlite.gz`;
    const backupPath = path.join(this.backupDir, backupName);
    
    try {
      const data = fs.readFileSync(this.dbPath);
      const compressed = zlib.gzipSync(data, { level: 9 });
      fs.writeFileSync(backupPath, compressed);
      
      const latestPath = path.join(this.backupDir, 'latest.sqlite.gz');
      fs.copyFileSync(backupPath, latestPath);
      
      const originalSize = (data.length / 1024 / 1024).toFixed(2);
      const compressedSize = (compressed.length / 1024 / 1024).toFixed(2);
      const savedPercent = ((1 - compressedSize / originalSize) * 100).toFixed(0);
      
      console.log(`✅ Бэкап создан: ${backupName}`);
      console.log(`📦 ${originalSize} MB → ${compressedSize} MB (экономия ${savedPercent}%)`);
      
      return backupPath;
    } catch (error) {
      console.error('❌ Ошибка создания бэкапа:', error);
      return null;
    }
  }

  cleanOldBackups() {
    try {
      let files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite.gz'))
        .sort();
      
      const validBackups = [];
      for (const file of files) {
        const filePath = path.join(this.backupDir, file);
        if (this.validateBackup(filePath)) {
          validBackups.push(file);
        } else {
          fs.unlinkSync(filePath);
          console.log(`🗑️ Удален поврежденный бэкап: ${file}`);
        }
      }
      
      validBackups.sort();
      files = validBackups;
      
      console.log(`📁 Найдено валидных бэкапов: ${files.length}`);
      
      if (files.length <= this.maxBackups) {
        console.log(`✅ Всего ${files.length} бэкапов (лимит ${this.maxBackups})`);
        return;
      }
      
      const toDelete = files.slice(0, files.length - this.maxBackups);
      let deleted = 0;
      
      for (const file of toDelete) {
        const filePath = path.join(this.backupDir, file);
        fs.unlinkSync(filePath);
        deleted++;
        console.log(`🗑️ Удален старый бэкап: ${file}`);
      }
      
      console.log(`✅ Очищено ${deleted} старых бэкапов. Осталось ${this.maxBackups}`);
      
    } catch (error) {
      console.error('❌ Ошибка очистки бэкапов:', error);
    }
  }

  async fullBackup() {
    console.log('\n🔄 Начинаем процесс бэкапа...');
    
    const backupPath = this.createBackup();
    if (!backupPath) {
      console.log('⚠️ Бэкап не создан');
      return false;
    }
    
    this.cleanOldBackups();
    console.log('✅ Процесс бэкапа завершен успешно\n');
    return true;
  }
}

const backup = new DatabaseBackup();

// ===== ВОССТАНОВЛЕНИЕ ПРИ СТАРТЕ =====
(async function restoreOnStart() {
  console.log('\n🔍 ПРОВЕРКА БАЗЫ ДАННЫХ ПРИ ЗАПУСКЕ...');
  
  let dbExists = fs.existsSync(backup.dbPath);
  let dbValid = false;
  
  if (dbExists) {
    try {
      const stats = fs.statSync(backup.dbPath);
      if (stats.size >= 100) {
        const data = fs.readFileSync(backup.dbPath);
        const header = data.slice(0, 16).toString('hex');
        if (header.startsWith('53514c69746520666f726d6174')) {
          dbValid = true;
          console.log(`✅ Текущая БД валидна (${(stats.size / 1024).toFixed(2)} KB)`);
        }
      }
    } catch (e) {
      console.log('⚠️ Ошибка проверки текущей БД:', e.message);
    }
  }
  
  if (!dbValid) {
    console.log('⚠️ Текущая БД повреждена или отсутствует!');
    console.log('🔄 Запускаем восстановление из бэкапа...');
    
    const restored = await backup.restoreFromBackup();
    
    if (restored) {
      console.log('✅ БД успешно восстановлена из бэкапа!');
    } else {
      console.log('⚠️ Не удалось восстановить БД. Будет создана новая.');
    }
  }
  
  console.log('✅ Проверка БД завершена\n');
})();

// ===== АВТОМАТИЧЕСКИЙ БЭКАП КАЖДЫЕ 7 МИНУТ =====
setInterval(() => {
  backup.fullBackup();
}, 7 * 60 * 1000);

// ===== БЭКАП ПРИ ВЫХОДЕ =====
process.on('SIGINT', () => {
  console.log('\n🔄 Бэкап перед выходом...');
  backup.fullBackup().then(() => {
    console.log('👋 Сервер остановлен');
    process.exit();
  });
});

process.on('SIGTERM', () => {
  console.log('\n🔄 Бэкап перед выходом...');
  backup.fullBackup().then(() => {
    console.log('👋 Сервер остановлен');
    process.exit();
  });
});

setTimeout(() => {
  backup.fullBackup();
}, 10000);

module.exports = backup;