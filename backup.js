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

  // ===== ПОЛУЧАЕМ ВСЕ ВАЛИДНЫЕ БЭКАПЫ С ДАТАМИ =====
  getValidBackups() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite.gz'))
        .sort();
      
      const validBackups = [];
      for (const file of files) {
        const filePath = path.join(this.backupDir, file);
        if (this.validateBackup(filePath)) {
          const stats = fs.statSync(filePath);
          validBackups.push({
            name: file,
            path: filePath,
            size: stats.size,
            mtime: stats.mtime,
            // Парсим дату из имени файла
            date: this.parseBackupDate(file)
          });
        }
      }
      
      // Сортируем по дате (новые сверху)
      validBackups.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      return validBackups;
    } catch (e) {
      console.error('❌ Ошибка получения бэкапов:', e);
      return [];
    }
  }

  // ===== ПАРСИМ ДАТУ ИЗ ИМЕНИ ФАЙЛА =====
  parseBackupDate(filename) {
    try {
      // backup-2026-07-23T18-52-04-123Z.sqlite.gz
      const match = filename.match(/backup-(.+)\.sqlite\.gz/);
      if (match) {
        const dateStr = match[1].replace(/T/g, ' ').replace(/-/g, ':');
        // Упрощенный парсинг
        const parts = filename.split('-');
        if (parts.length >= 4) {
          const year = parts[1];
          const month = parts[2];
          const day = parts[3].split('T')[0];
          const time = parts[3].split('T')[1]?.split('.')[0] || '00:00:00';
          return new Date(`${year}-${month}-${day}T${time}Z`);
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // ===== ВОССТАНОВЛЕНИЕ ИЗ САМОГО СВЕЖЕГО БЭКАПА =====
  async restoreFromLatestBackup() {
    console.log('\n🔄 ПОИСК СВЕЖЕГО БЭКАПА...');
    
    // Получаем все валидные бэкапы
    const backups = this.getValidBackups();
    
    if (backups.length === 0) {
      console.log('ℹ️ Нет валидных бэкапов');
      return false;
    }
    
    // Берем самый свежий
    const latest = backups[0];
    console.log(`📥 Найден свежий бэкап: ${latest.name}`);
    console.log(`📅 Дата: ${latest.mtime.toLocaleString('ru-RU')}`);
    console.log(`📦 Размер: ${(latest.size / 1024 / 1024).toFixed(2)} MB`);
    
    try {
      const compressed = fs.readFileSync(latest.path);
      const data = zlib.gunzipSync(compressed);
      
      // Сохраняем как latest.sqlite.gz
      const latestPath = path.join(this.backupDir, 'latest.sqlite.gz');
      fs.writeFileSync(latestPath, compressed);
      
      // Восстанавливаем БД
      fs.writeFileSync(this.dbPath, data);
      console.log(`✅ БД восстановлена из свежего бэкапа! Размер: ${(data.length / 1024 / 1024).toFixed(2)} MB`);
      console.log(`📅 Бэкап от: ${latest.mtime.toLocaleString('ru-RU')}`);
      
      return true;
    } catch (error) {
      console.error('❌ Ошибка восстановления:', error);
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

  // ===== ВОССТАНОВЛЕНИЕ (ПРИОРИТЕТ ЛОКАЛЬНОМУ БЭКАПУ) =====
  async restoreFromBackup() {
    console.log('\n🔄 ПРОВЕРКА БЭКАПОВ...');
    
    // 1. Сначала пробуем локальный свежий бэкап (приоритет)
    const localRestored = await this.restoreFromLatestBackup();
    if (localRestored) {
      console.log('✅ Восстановлен из локального бэкапа');
      return true;
    }
    
    // 2. Если локального нет - пробуем GitHub
    try {
      console.log('🔄 Пробуем GitHub...');
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
      
      // Сохраняем как latest
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
      const backups = this.getValidBackups();
      const files = backups.map(b => b.name);
      
      console.log(`📁 Найдено валидных бэкапов: ${files.length}`);
      
      if (files.length <= this.maxBackups) {
        console.log(`✅ Всего ${files.length} бэкапов (лимит ${this.maxBackups})`);
        return;
      }
      
      // Удаляем самые старые (кроме последних maxBackups)
      const toDelete = files.slice(this.maxBackups);
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

// ===== ВОССТАНОВЛЕНИЕ ИЗ СВЕЖЕГО БЭКАПА ПРИ СТАРТЕ =====
(async function restoreOnStart() {
  console.log('\n🔍 ПРОВЕРКА БАЗЫ ДАННЫХ ПРИ ЗАПУСКЕ...');
  
  let dbExists = fs.existsSync(backup.dbPath);
  let dbValid = false;
  let dbHasUsers = false;
  
  if (dbExists) {
    try {
      const stats = fs.statSync(backup.dbPath);
      if (stats.size >= 100) {
        const data = fs.readFileSync(backup.dbPath);
        const header = data.slice(0, 16).toString('hex');
        if (header.startsWith('53514c69746520666f726d6174')) {
          dbValid = true;
          // Проверяем наличие пользователей
          const str = data.toString('utf8', 0, Math.min(data.length, 5000));
          dbHasUsers = str.includes('ad6@gmail.com') && str.includes('users');
          console.log(`✅ Текущая БД валидна (${(stats.size / 1024).toFixed(2)} KB)`);
          console.log(`👤 Пользователи: ${dbHasUsers ? 'есть' : 'НЕТ!'}`);
        }
      }
    } catch (e) {
      console.log('⚠️ Ошибка проверки текущей БД:', e.message);
    }
  }
  
  // ВСЕГДА проверяем свежий бэкап
  const backups = backup.getValidBackups();
  if (backups.length > 0) {
    const latest = backups[0];
    console.log(`📦 Свежий бэкап: ${latest.name} (${latest.mtime.toLocaleString('ru-RU')})`);
    
    // Если в БД нет пользователей ИЛИ бэкап новее текущей БД
    const needRestore = !dbValid || !dbHasUsers;
    
    if (needRestore) {
      console.log('🔄 Восстанавливаем из свежего бэкапа...');
      await backup.restoreFromLatestBackup();
    } else {
      console.log('✅ БД валидна, пользователи есть');
    }
  } else {
    console.log('⚠️ Нет бэкапов для проверки');
  }
  
  console.log('✅ Проверка БД завершена\n');
})();

// ===== БЭКАП КАЖДЫЕ 3 МИНУТЫ (чаще) =====
setInterval(async () => {
  console.log('⏰ Автоматический бэкап...');
  await backup.fullBackup();
}, 3 * 60 * 1000);

// ===== ПРОВЕРКА БД КАЖДУЮ МИНУТУ =====
setInterval(async () => {
  try {
    if (!fs.existsSync(backup.dbPath)) {
      console.log('⚠️ БД исчезла! Восстанавливаем из бэкапа...');
      await backup.restoreFromLatestBackup();
      return;
    }
    
    const stats = fs.statSync(backup.dbPath);
    if (stats.size < 100) {
      console.log('⚠️ БД стала слишком маленькой! Восстанавливаем из бэкапа...');
      await backup.restoreFromLatestBackup();
      return;
    }
    
    const data = fs.readFileSync(backup.dbPath);
    const header = data.slice(0, 16).toString('hex');
    if (!header.startsWith('53514c69746520666f726d6174')) {
      console.log('⚠️ БД повреждена! Восстанавливаем из бэкапа...');
      await backup.restoreFromLatestBackup();
      return;
    }
    
    // Проверяем наличие админа
    const str = data.toString('utf8', 0, Math.min(data.length, 2000));
    if (!str.includes('ad6@gmail.com')) {
      console.log('⚠️ В БД нет админа! Восстанавливаем из бэкапа...');
      await backup.restoreFromLatestBackup();
    }
  } catch (e) {
    console.log('⚠️ Ошибка проверки БД:', e.message);
  }
}, 60 * 1000);

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

// Бэкап через 3 секунды после старта
setTimeout(() => {
  backup.fullBackup();
}, 3000);

module.exports = backup;