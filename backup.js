const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const zlib = require('zlib');

class DatabaseBackup {
  constructor() {
    this.dbPath = path.join(__dirname, 'database.sqlite');
    this.backupDir = path.join(__dirname, 'backups');
    this.maxBackups = 16;
    
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
    
    console.log('📁 Папка для бэкапов создана');
  }

  createBackup() {
    if (!fs.existsSync(this.dbPath)) {
      console.log('❌ База данных не найдена');
      return null;
    }

    const sizeMB = (fs.statSync(this.dbPath).size / 1024 / 1024).toFixed(2);
    console.log(`📊 Текущий размер БД: ${sizeMB} MB`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}.sqlite.gz`;
    const backupPath = path.join(this.backupDir, backupName);
    
    try {
      const data = fs.readFileSync(this.dbPath);
      const compressed = zlib.gzipSync(data, { level: 9 });
      fs.writeFileSync(backupPath, compressed);
      
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
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite.gz'))
        .sort();
      
      console.log(`📁 Найдено бэкапов: ${files.length}`);
      
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

  // ===== ИСПРАВЛЕННАЯ ФУНКЦИЯ =====
  syncToGitHub() {
    return new Promise((resolve, reject) => {
      console.log('📤 Отправка бэкапов в GitHub...');
      
      // ИСПОЛЬЗУЕМ -f ЧТОБЫ ДОБАВИТЬ ДАЖЕ ЕСЛИ В .gitignore
      exec('git add -f backups/', (error) => {
        if (error) console.log('⚠️ git add:', error.message);
        
        exec('git status --porcelain', (err, status) => {
          if (err) console.log('⚠️ git status error:', err.message);
          
          if (status && status.trim()) {
            const message = `Auto backup: ${new Date().toISOString()}`;
            exec(`git commit -m "${message}"`, (err2) => {
              if (err2) console.log('⚠️ git commit:', err2.message);
              
              exec('git push origin main', (err3) => {
                if (err3) {
                  console.log('⚠️ git push error:', err3.message);
                  exec('git push origin main --force', (err4) => {
                    if (err4) {
                      console.error('❌ Ошибка отправки в GitHub:', err4.message);
                      reject(err4);
                    } else {
                      console.log('✅ Бэкапы отправлены в GitHub (force)');
                      resolve();
                    }
                  });
                } else {
                  console.log('✅ Бэкапы отправлены в GitHub');
                  resolve();
                }
              });
            });
          } else {
            console.log('ℹ️ Нет изменений для коммита');
            resolve();
          }
        });
      });
    });
  }

  async fullBackup() {
    console.log('\n🔄 Начинаем процесс бэкапа...');
    
    const backupPath = this.createBackup();
    if (!backupPath) {
      console.log('❌ Бэкап не создан');
      return false;
    }
    
    this.cleanOldBackups();
    
    try {
      await this.syncToGitHub();
      console.log('✅ Процесс бэкапа завершен успешно\n');
      return true;
    } catch (error) {
      console.error('❌ Ошибка синхронизации с GitHub:', error);
      return false;
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
      
      const latest = files[files.length - 1];
      const backupPath = path.join(this.backupDir, latest);
      
      console.log(`📥 Восстановление из: ${latest}`);
      
      const compressed = fs.readFileSync(backupPath);
      const data = zlib.gunzipSync(compressed);
      fs.writeFileSync(this.dbPath, data);
      
      console.log(`✅ БД восстановлена! Размер: ${(data.length / 1024 / 1024).toFixed(2)} MB`);
      return true;
    } catch (error) {
      console.error('❌ Ошибка восстановления:', error);
      return false;
    }
  }

  async restoreFromGitHub() {
    console.log('🔄 Проверка бэкапов в GitHub...');
    
    return new Promise((resolve) => {
      exec('git pull origin main', (error) => {
        if (error) {
          console.log('⚠️ Не удалось обновить репозиторий');
          const restored = this.restoreLatestBackup();
          resolve(restored);
          return;
        }
        
        console.log('📥 Репозиторий обновлен');
        const restored = this.restoreLatestBackup();
        resolve(restored);
      });
    });
  }
}

const backup = new DatabaseBackup();

// Бэкап каждые 10 минут
setInterval(() => {
  backup.fullBackup();
}, 10 * 60 * 1000);

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