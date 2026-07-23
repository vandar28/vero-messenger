const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

class DatabaseBackup {
  constructor() {
    this.dbPath = path.join(__dirname, 'database.sqlite');
    this.backupDir = path.join(__dirname, 'backups');
    this.maxBackups = 7; // ← Храним только 7 последних бэкапов
    
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
    
    console.log('📁 Папка для бэкапов создана');
    console.log(`📦 Максимум бэкапов: ${this.maxBackups}`);
  }

  // ===== ПРОВЕРКА ЦЕЛОСТНОСТИ БЭКАПА =====
  validateBackup(filePath) {
    try {
      const compressed = fs.readFileSync(filePath);
      const data = zlib.gunzipSync(compressed);
      
      // Проверяем что это SQLite (заголовок)
      const header = data.slice(0, 16).toString('hex');
      if (!header.startsWith('53514c69746520666f726d6174')) {
        console.log(`⚠️ Бэкап ${path.basename(filePath)} поврежден (не SQLite)`);
        return false;
      }
      
      // Проверяем что есть хоть какие-то данные
      if (data.length < 100) {
        console.log(`⚠️ Бэкап ${path.basename(filePath)} слишком маленький (${data.length} байт)`);
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
            console.log(`✅ Бэкап скачан с GitHub! Размер: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
            resolve(buffer);
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

  async restoreFromGitHub() {
    console.log('🔄 Проверка бэкапов в GitHub...');
    
    try {
      const data = await this.downloadBackupFromGitHub();
      if (!data) {
        console.log('ℹ️ Бэкап не найден на GitHub, пробуем локальный...');
        return this.restoreLatestBackup();
      }
      
      // Проверяем что данные не пустые
      if (data.length < 100) {
        console.log('⚠️ Бэкап слишком маленький, возможно пустой');
        return this.restoreLatestBackup();
      }
      
      const decompressed = zlib.gunzipSync(data);
      
      // Проверяем что это SQLite
      const header = decompressed.slice(0, 16).toString('hex');
      if (!header.startsWith('53514c69746520666f726d6174')) {
        console.log('⚠️ Бэкап поврежден (не SQLite), пробуем локальный...');
        return this.restoreLatestBackup();
      }
      
      fs.writeFileSync(this.dbPath, decompressed);
      
      console.log(`✅ БД восстановлена из GitHub! Размер: ${(decompressed.length / 1024 / 1024).toFixed(2)} MB`);
      return true;
      
    } catch (error) {
      console.error('❌ Ошибка восстановления из GitHub:', error.message);
      console.log('🔄 Пробуем восстановить из локального бэкапа...');
      return this.restoreLatestBackup();
    }
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
      // Сохраняем БД
      const data = fs.readFileSync(this.dbPath);
      const compressed = zlib.gzipSync(data, { level: 9 });
      fs.writeFileSync(backupPath, compressed);
      
      // Сохраняем как latest
      const latestPath = path.join(this.backupDir, 'latest.sqlite.gz');
      fs.copyFileSync(backupPath, latestPath);
      
      const originalSize = (data.length / 1024 / 1024).toFixed(2);
      const compressedSize = (compressed.length / 1024 / 1024).toFixed(2);
      const savedPercent = ((1 - compressedSize / originalSize) * 100).toFixed(0);
      
      console.log(`✅ Бэкап создан: ${backupName}`);
      console.log(`📦 ${originalSize} MB → ${compressedSize} MB (экономия ${savedPercent}%)`);
      
      // Проверяем созданный бэкап
      this.validateBackup(backupPath);
      
      return backupPath;
    } catch (error) {
      console.error('❌ Ошибка создания бэкапа:', error);
      return null;
    }
  }

  // ===== УДАЛЯЕМ СТАРЫЕ БЭКАПЫ (оставляем только 7) =====
  cleanOldBackups() {
    try {
      // Получаем все бэкапы
      let files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite.gz'))
        .sort();
      
      // Проверяем валидность каждого бэкапа
      const validBackups = [];
      for (const file of files) {
        const filePath = path.join(this.backupDir, file);
        if (this.validateBackup(filePath)) {
          validBackups.push(file);
        } else {
          // Удаляем поврежденный бэкап
          fs.unlinkSync(filePath);
          console.log(`🗑️ Удален поврежденный бэкап: ${file}`);
        }
      }
      
      // Сортируем по дате (новые сверху)
      validBackups.sort();
      files = validBackups;
      
      console.log(`📁 Найдено валидных бэкапов: ${files.length}`);
      
      // Если бэкапов меньше или равно максимуму - ничего не делаем
      if (files.length <= this.maxBackups) {
        console.log(`✅ Всего ${files.length} бэкапов (лимит ${this.maxBackups})`);
        return;
      }
      
      // Удаляем самые старые (первые в списке)
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

  restoreLatestBackup() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite.gz'))
        .sort();
      
      if (files.length === 0) {
        console.log('ℹ️ Нет локальных бэкапов');
        return false;
      }
      
      // Ищем последний валидный бэкап
      let latest = null;
      for (let i = files.length - 1; i >= 0; i--) {
        const filePath = path.join(this.backupDir, files[i]);
        if (this.validateBackup(filePath)) {
          latest = files[i];
          break;
        }
      }
      
      if (!latest) {
        console.log('⚠️ Нет валидных бэкапов для восстановления');
        return false;
      }
      
      const backupPath = path.join(this.backupDir, latest);
      console.log(`📥 Восстановление из локального бэкапа: ${latest}`);
      
      const compressed = fs.readFileSync(backupPath);
      const data = zlib.gunzipSync(compressed);
      
      fs.writeFileSync(this.dbPath, data);
      console.log(`✅ БД восстановлена! Размер: ${(data.length / 1024 / 1024).toFixed(2)} MB`);
      return true;
      
    } catch (error) {
      console.error('❌ Ошибка восстановления из локального бэкапа:', error);
      return false;
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

// ===== БЭКАП КАЖДЫЕ 7 МИНУТ =====
setInterval(() => {
  backup.fullBackup();
}, 7 * 60 * 1000);

// Бэкап при выходе
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

// Бэкап через 5 секунд после старта
setTimeout(() => {
  backup.fullBackup();
}, 5000);

module.exports = backup;