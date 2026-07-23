const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===== НАСТРОЙКА =====
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

const IS_CONFIGURED = !!(CLOUD_NAME && API_KEY && API_SECRET);

if (IS_CONFIGURED) {
  cloudinary.config({
    cloud_name: CLOUD_NAME,
    api_key: API_KEY,
    api_secret: API_SECRET,
  });
  console.log('✅ Cloudinary настроен');
  console.log(`📦 Cloud Name: ${CLOUD_NAME}`);
} else {
  console.warn('⚠️ Cloudinary НЕ настроен! Файлы будут сохраняться локально.');
}

// ===== ОСНОВНАЯ ФУНКЦИЯ ЗАГРУЗКИ =====
async function uploadFile(fileBuffer, originalName, mimeType, folder = 'uploads') {
  // Локальное сохранение (всегда)
  const publicPath = path.join(__dirname, 'public', folder, originalName);
  const publicDir = path.dirname(publicPath);
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(publicPath, fileBuffer);
  console.log(`📁 Файл сохранен локально: ${publicPath}`);

  if (!IS_CONFIGURED) {
    return `/${folder}/${originalName}`;
  }

  try {
    // ОПРЕДЕЛЯЕМ ТИП РЕСУРСА
    let resourceType = 'auto';
    let isVideo = false;
    let isAudio = false;
    
    if (mimeType) {
      if (mimeType.startsWith('video/')) {
        resourceType = 'video';
        isVideo = true;
      } else if (mimeType.startsWith('image/')) {
        resourceType = 'image';
      } else if (mimeType.startsWith('audio/')) {
        resourceType = 'video';
        isAudio = true;
      }
    }
    
    // Проверяем расширение
    const ext = path.extname(originalName).toLowerCase();
    const videoExts = ['.webm', '.mp4', '.mov', '.avi', '.mkv', '.ogv', '.3gp', '.m4v', '.flv'];
    const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
    
    if (videoExts.includes(ext)) {
      resourceType = 'video';
      isVideo = true;
    } else if (audioExts.includes(ext)) {
      resourceType = 'video';
      isAudio = true;
    }
    
    console.log(`📹 Тип ресурса: ${resourceType} (${mimeType || 'unknown'})`);

    // Строим трансформации
    let transformation = [];
    let eager = [];
    
    if (folder === 'avatars') {
      transformation = [
        { width: 200, height: 200, crop: 'fill', gravity: 'face' }
      ];
    } else if (isVideo) {
      // ДЛЯ ВИДЕО - ОПТИМИЗАЦИЯ ДЛЯ КРУЖКОВ
      transformation = [
        { width: 480, height: 480, crop: 'limit' },
        { quality: 'auto:good' }
      ];
      eager = [
        { 
          format: 'jpg', 
          width: 480, 
          height: 480, 
          crop: 'thumb',
          quality: 'auto'
        }
      ];
    } else if (isAudio) {
      transformation = [
        { quality: 'auto' }
      ];
    }

    // Генерируем уникальное имя
    const nameWithoutExt = path.parse(originalName).name;
    const uniqueId = crypto.randomUUID() + '_' + nameWithoutExt;

    // ЗАГРУЗКА
    const result = await new Promise((resolve, reject) => {
      const uploadOptions = {
        folder: folder,
        resource_type: resourceType,
        use_filename: true,
        unique_filename: true,
        public_id: uniqueId,
        transformation: transformation,
        quality: 'auto',
        fetch_format: 'auto',
      };
      
      if (isVideo && eager.length > 0) {
        uploadOptions.eager = eager;
        uploadOptions.eager_async = true;
      }
      
      const uploadStream = cloudinary.uploader.upload_stream(
        uploadOptions,
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(fileBuffer);
    });

    console.log(`✅ Файл загружен в Cloudinary: ${result.public_id}`);
    console.log(`📎 URL: ${result.secure_url}`);
    if (result.duration) {
      console.log(`⏱️ Длительность: ${result.duration}s`);
    }

    // Удаляем локальный файл
    if (fs.existsSync(publicPath)) {
      fs.unlinkSync(publicPath);
      console.log(`🗑️ Локальный файл удален (загружен в Cloudinary)`);
    }

    return result.secure_url;
    
  } catch (error) {
    console.error('❌ Ошибка загрузки в Cloudinary:', error.message);
    console.log(`📁 Файл оставлен локально: ${publicPath}`);
    return `/${folder}/${originalName}`;
  }
}

// ===== УДАЛЕНИЕ ФАЙЛА =====
async function deleteFile(fileUrl) {
  if (!fileUrl) return;
  
  if (!fileUrl.startsWith('http')) {
    const localPath = path.join(__dirname, 'public', fileUrl);
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
      console.log(`🗑️ Локальный файл удален: ${localPath}`);
    }
    return;
  }

  if (!IS_CONFIGURED) return;

  try {
    const url = new URL(fileUrl);
    const pathParts = url.pathname.split('/');
    const uploadIndex = pathParts.indexOf('upload');
    if (uploadIndex === -1) return;
    
    let publicId = pathParts.slice(uploadIndex + 2).join('/');
    publicId = publicId.replace(/\.[^/.]+$/, '');
    
    let resourceType = 'image';
    if (fileUrl.includes('/video/upload/') || fileUrl.includes('video/')) {
      resourceType = 'video';
    }
    
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    console.log(`🗑️ Файл удален из Cloudinary: ${publicId}`);
  } catch (error) {
    console.error('❌ Ошибка удаления из Cloudinary:', error.message);
  }
}

// ===== ПОЛУЧЕНИЕ ИНФОРМАЦИИ =====
async function getFileInfo(fileUrl) {
  if (!IS_CONFIGURED || !fileUrl) return null;
  try {
    const url = new URL(fileUrl);
    const pathParts = url.pathname.split('/');
    const uploadIndex = pathParts.indexOf('upload');
    if (uploadIndex === -1) return null;
    
    let publicId = pathParts.slice(uploadIndex + 2).join('/');
    publicId = publicId.replace(/\.[^/.]+$/, '');
    
    let resourceType = 'image';
    if (fileUrl.includes('/video/upload/') || fileUrl.includes('video/')) {
      resourceType = 'video';
    }
    
    const result = await cloudinary.api.resource(publicId, { resource_type: resourceType });
    return result;
  } catch (error) {
    console.error('❌ Ошибка получения информации:', error.message);
    return null;
  }
}

module.exports = {
  uploadFile,
  deleteFile,
  getFileInfo,
  isConfigured: IS_CONFIGURED,
};