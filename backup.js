const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class DatabaseBackup {
  constructor() {
    this.dbPath = path.join(__dirname, 'database.sqlite');
    this.backupDir = path.join(__dirname, 'backups');
    this.backupName = 'backup.sqlite.gz'; // ОДИН ФАЙЛ
    
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
    
    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
    this.isBackupInProgress = false;
    
    console.log('📁 Папка для бэкапов создана');
    console.log('📦 ОДИН бэкап (простая перезапись)');
  }

  validateBackup(filePath) {
    try {
      if (!fs.existsSync(filePath)) return false;
      
      const stats = fs.statSync(filePath);
      if (stats.size < 100) return false;
      
      const compressed = fs.readFileSync(filePath);
      const data = zlib.gunzipSync(compressed);
      
      const header = data.slice(0, 16).toString('hex');
      if (!header.startsWith('53514c69746520666f726d6174')) return false;
      
      if (data.length < 1000) return false;
      
      const str = data.toString('utf8', 0, Math.min(data.length, 5000));
      if (!str.includes('CREATE TABLE') && !str.includes('users')) return false;
      
      return true;
    } catch (error) {
      return false;
    }
  }

  getBackupInfo() {
    try {
      const backupPath = path.join(this.backupDir, this.backupName);
      if (!fs.existsSync(backupPath)) return null;
      
      if (!this.validateBackup(backupPath)) return null;
      
      const stats = fs.statSync(backupPath);
      return {
        name: this.backupName,
        path: backupPath,
        size: stats.size,
        mtime: stats.mtime
      };
    } catch (e) {
      return null;
    }
  }

  createBackup() {
    if (this.isBackupInProgress) {
      console.log('⏳ Бэкап уже выполняется');
      return null;
    }
    
    this.isBackupInProgress = true;
    
    try {
      if (!fs.existsSync(this.dbPath)) {
        console.log('❌ База данных не найдена');
        return null;
      }

      const stats = fs.statSync(this.dbPath);
      if (stats.size < 100) {
        console.log('⚠️ БД слишком маленькая');
        return null;
      }

      const data = fs.readFileSync(this.dbPath);
      if (data.length < 1000) {
        console.log('⚠️ БД повреждена');
        return null;
      }

      const backupPath = path.join(this.backupDir, this.backupName);
      
      const compressed = zlib.gzipSync(data, { level: 9 });
      
      if (compressed.length < 100) {
        console.log('⚠️ Сжатые данные слишком маленькие');
        return null;
      }
      
      // ПРОСТО ПЕРЕЗАПИСЫВАЕМ ФАЙЛ
      fs.writeFileSync(backupPath, compressed);
      
      const originalSize = (data.length / 1024 / 1024).toFixed(2);
      const compressedSize = (compressed.length / 1024 / 1024).toFixed(2);
      
      console.log(`✅ Бэкап создан: ${this.backupName}`);
      console.log(`📦 ${originalSize} MB → ${compressedSize} MB`);
      
      // Обновляем статус для фронтенда
      this.updateFrontendStatus();
      
      return backupPath;
      
    } catch (error) {
      console.error('❌ Ошибка создания бэкапа:', error);
      return null;
    } finally {
      this.isBackupInProgress = false;
    }
  }

  updateFrontendStatus() {
    try {
      const statusPath = path.join(__dirname, 'public', 'backup-status.json');
      const backupInfo = this.getBackupInfo();
      
      let status = {
        lastBackup: null,
        total: 0,
        max: 1,
        backups: []
      };
      
      if (backupInfo) {
        status = {
          lastBackup: backupInfo.mtime.toISOString(),
          total: 1,
          max: 1,
          backups: [{
            name: backupInfo.name,
            size: (backupInfo.size / 1024).toFixed(2) + ' KB',
            date: backupInfo.mtime.toISOString(),
            isLatest: true
          }]
        };
      }
      
      fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
      console.log('📡 Статус бэкапа обновлен');
    } catch (e) {
      console.log('⚠️ Ошибка обновления статуса:', e.message);
    }
  }

  async restoreFromBackup() {
    console.log('\n🔄 ПОИСК БЭКАПА...');
    
    const backupInfo = this.getBackupInfo();
    
    if (!backupInfo) {
      console.log('ℹ️ Нет валидного бэкапа');
      return false;
    }
    
    console.log(`📥 Найден бэкап: ${backupInfo.name}`);
    console.log(`📅 Дата: ${backupInfo.mtime.toLocaleString('ru-RU')}`);
    console.log(`📦 Размер: ${(backupInfo.size / 1024).toFixed(2)} KB`);
    
    try {
      const compressed = fs.readFileSync(backupInfo.path);
      const data = zlib.gunzipSync(compressed);
      
      fs.writeFileSync(this.dbPath, data);
      console.log(`✅ БД восстановлена! Размер: ${(data.length / 1024 / 1024).toFixed(2)} MB`);
      return true;
    } catch (error) {
      console.error('❌ Ошибка восстановления:', error);
      return false;
    }
  }

  async instantBackup(reason = 'изменение') {
    console.log(`⚡ Мгновенный бэкап (${reason})...`);
    return !!this.createBackup();
  }

  async fullBackup() {
    return this.instantBackup('завершение работы');
  }
}

const backup = new DatabaseBackup();

(async function restoreOnStart() {
  console.log('\n🔍 ПРОВЕРКА БАЗЫ ДАННЫХ ПРИ ЗАПУСКЕ...');
  
  let dbValid = false;
  
  if (fs.existsSync(backup.dbPath)) {
    try {
      const stats = fs.statSync(backup.dbPath);
      if (stats.size >= 1000) {
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
    await backup.restoreFromBackup();
  }
  
  backup.updateFrontendStatus();
  console.log('✅ Проверка БД завершена\n');
})();

// ===== БЭКАП КАЖДУЮ МИНУТУ =====
setInterval(async () => {
  console.log('⏰ Плановый бэкап...');
  await backup.instantBackup('плановый');
}, 60 * 1000);

// ===== ОБНОВЛЕНИЕ СТАТУСА НА САЙТЕ КАЖДЫЕ 6 МИНУТ =====
setInterval(() => {
  console.log('📡 Обновление статуса бэкапа на сайте...');
  backup.updateFrontendStatus();
}, 6 * 60 * 1000);

// ===== ПРОВЕРКА БД КАЖДЫЕ 30 СЕКУНД =====
setInterval(async () => {
  try {
    if (!fs.existsSync(backup.dbPath)) {
      console.log('⚠️ БД исчезла! Восстанавливаем...');
      await backup.restoreFromBackup();
      return;
    }
    
    const stats = fs.statSync(backup.dbPath);
    if (stats.size < 1000) {
      console.log('⚠️ БД слишком маленькая! Восстанавливаем...');
      await backup.restoreFromBackup();
      return;
    }
  } catch (e) {
    console.log('⚠️ Ошибка проверки БД:', e.message);
  }
}, 30 * 1000);

process.on('SIGINT', async () => {
  console.log('\n🔄 Бэкап перед выходом...');
  await backup.fullBackup();
  console.log('👋 Сервер остановлен');
  process.exit();
});

process.on('SIGTERM', async () => {
  console.log('\n🔄 Бэкап перед выходом...');
  await backup.fullBackup();
  console.log('👋 Сервер остановлен');
  process.exit();
});

setTimeout(async () => {
  await backup.instantBackup('старт');
}, 3000);

module.exports = backup;