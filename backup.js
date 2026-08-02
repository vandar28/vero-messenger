const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class DatabaseBackup {
  constructor() {
    this.dbPath = path.join(__dirname, 'database.sqlite');
    this.backupDir = path.join(__dirname, 'backups');
    this.backupName = 'backup.sqlite.gz';
    
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
    
    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
    this.isBackupInProgress = false;
    this.lastBackupTime = 0;
    this.minBackupInterval = 3000; // 3 секунды между бэкапами
    
    console.log('📁 Папка для бэкапов создана');
    console.log('📦 ОДИН бэкап (простая перезапись)');
  }

  validateBackup(filePath) {
    try {
      if (!fs.existsSync(filePath)) return false;
      
      const stats = fs.statSync(filePath);
      if (stats.size < 100) return false;
      
      const compressed = fs.readFileSync(filePath);
      if (compressed.length < 100) return false;
      
      // Пытаемся распаковать
      const data = zlib.gunzipSync(compressed);
      
      // Проверяем сигнатуру SQLite
      const header = data.slice(0, 16).toString('hex');
      if (!header.startsWith('53514c69746520666f726d6174')) {
        return false;
      }
      
      // Проверяем наличие данных
      if (data.length < 1000) return false;
      
      // Проверяем наличие таблиц
      const str = data.toString('utf8', 0, Math.min(data.length, 5000));
      if (!str.includes('CREATE TABLE') && !str.includes('users')) {
        return false;
      }
      
      return true;
    } catch (error) {
      console.log('⚠️ Ошибка валидации бэкапа:', error.message);
      return false;
    }
  }

  getBackupInfo() {
    try {
      const backupPath = path.join(this.backupDir, this.backupName);
      if (!fs.existsSync(backupPath)) return null;
      
      if (!this.validateBackup(backupPath)) {
        console.log('⚠️ Бэкап поврежден, удаляем...');
        fs.unlinkSync(backupPath);
        return null;
      }
      
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
    // Защита от слишком частых бэкапов
    const now = Date.now();
    if (now - this.lastBackupTime < this.minBackupInterval) {
      console.log('⏳ Слишком часто, пропускаем бэкап');
      return null;
    }
    
    if (this.isBackupInProgress) {
      console.log('⏳ Бэкап уже выполняется');
      return null;
    }
    
    this.isBackupInProgress = true;
    
    try {
      // ПРОВЕРЯЕМ, ЧТО БД СУЩЕСТВУЕТ И НЕ ПУСТАЯ
      if (!fs.existsSync(this.dbPath)) {
        console.log('❌ База данных не найдена');
        this.isBackupInProgress = false;
        return null;
      }

      const stats = fs.statSync(this.dbPath);
      if (stats.size < 1000) {
        console.log(`⚠️ БД слишком маленькая (${stats.size} байт), пропускаем бэкап`);
        this.isBackupInProgress = false;
        return null;
      }

      const data = fs.readFileSync(this.dbPath);
      if (data.length < 1000) {
        console.log(`⚠️ БД повреждена (${data.length} байт), пропускаем бэкап`);
        this.isBackupInProgress = false;
        return null;
      }

      // ПРОВЕРЯЕМ, ЧТО БД ВАЛИДНА (ЕСТЬ SQLite СИГНАТУРА)
      const header = data.slice(0, 16).toString('hex');
      if (!header.startsWith('53514c69746520666f726d6174')) {
        console.log('⚠️ БД не является SQLite, пропускаем бэкап');
        this.isBackupInProgress = false;
        return null;
      }

      // ПРОВЕРЯЕМ, ЧТО В БД ЕСТЬ ПОЛЬЗОВАТЕЛИ
      const str = data.toString('utf8', 0, Math.min(data.length, 5000));
      if (!str.includes('ad6@gmail.com') && !str.includes('users')) {
        console.log('⚠️ В БД нет пользователей, пропускаем бэкап');
        this.isBackupInProgress = false;
        return null;
      }

      const backupPath = path.join(this.backupDir, this.backupName);
      
      // Сжимаем с максимальным сжатием
      const compressed = zlib.gzipSync(data, { level: 9 });
      
      if (compressed.length < 100) {
        console.log('⚠️ Сжатые данные слишком маленькие');
        this.isBackupInProgress = false;
        return null;
      }
      
      // ВРЕМЕННО СОХРАНЯЕМ В ДРУГОЙ ФАЙЛ, ЧТОБЫ НЕ ПОВРЕДИТЬ СУЩЕСТВУЮЩИЙ
      const tempPath = backupPath + '.tmp';
      fs.writeFileSync(tempPath, compressed);
      
      // Проверяем временный бэкап
      if (!this.validateBackup(tempPath)) {
        console.log('⚠️ Временный бэкап поврежден, отмена');
        fs.unlinkSync(tempPath);
        this.isBackupInProgress = false;
        return null;
      }
      
      // Если проверка прошла, заменяем основной файл
      fs.renameSync(tempPath, backupPath);
      
      const originalSize = (data.length / 1024 / 1024).toFixed(2);
      const compressedSize = (compressed.length / 1024 / 1024).toFixed(2);
      
      console.log(`✅ Бэкап создан: ${this.backupName}`);
      console.log(`📦 ${originalSize} MB → ${compressedSize} MB`);
      
      this.lastBackupTime = now;
      
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
        console.log(`📡 Статус бэкапа обновлен: ${(backupInfo.size / 1024).toFixed(2)} KB`);
      } else {
        console.log('⚠️ Нет валидного бэкапа для статуса');
      }
      
      fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
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
      
      // Проверяем, что БД действительно валидна
      if (data.length < 1000) {
        console.log('⚠️ Восстановленная БД слишком маленькая');
        return false;
      }
      
      // Делаем бэкап текущей БД перед восстановлением
      if (fs.existsSync(this.dbPath)) {
        const backupPath = this.dbPath + '.old';
        fs.copyFileSync(this.dbPath, backupPath);
        console.log(`💾 Создан бэкап текущей БД: ${backupPath}`);
      }
      
      fs.writeFileSync(this.dbPath, data);
      console.log(`✅ БД восстановлена! Размер: ${(data.length / 1024 / 1024).toFixed(2)} MB`);
      this.updateFrontendStatus();
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
          const str = data.toString('utf8', 0, Math.min(data.length, 5000));
          if (str.includes('ad6@gmail.com') || str.includes('users')) {
            dbValid = true;
            console.log(`✅ Текущая БД валидна (${(stats.size / 1024).toFixed(2)} KB)`);
          }
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
  
  // Принудительно обновляем статус
  backup.updateFrontendStatus();
  console.log('✅ Проверка БД завершена\n');
})();

// ===== БЭКАП КАЖДЫЕ 10 МИНУТ =====
setInterval(async () => {
  console.log('⏰ Плановый бэкап...');
  await backup.instantBackup('плановый');
}, 10 * 60 * 1000);

// ===== ОБНОВЛЕНИЕ СТАТУСА НА САЙТЕ КАЖДЫЕ 30 СЕКУНД =====
setInterval(() => {
  console.log('📡 Обновление статуса бэкапа на сайте...');
  backup.updateFrontendStatus();
}, 30 * 1000);

// ===== ПРОВЕРКА БД КАЖДУЮ МИНУТУ =====
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
}, 60 * 1000);

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
  console.log('🔄 Первый бэкап после старта...');
  await backup.instantBackup('старт');
}, 5000);

module.exports = backup;