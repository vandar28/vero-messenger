const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===== НАСТРОЙКА CLOUDINARY =====
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

// ===== ЗАГРУЗКА ФАЙЛА В CLOUDINARY =====
async function uploadFile(fileBuffer, originalName, mimeType, folder = 'uploads') {
  // Сохраняем локально на всякий случай
  const publicPath = path.join(__dirname, 'public', folder, originalName);
  const publicDir = path.dirname(publicPath);
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(publicPath, fileBuffer);
  console.log(`📁 Файл сохранен локально: ${publicPath}`);

  if (!IS_CONFIGURED) {
    return `/${folder}/${originalName}`;
  }

  try {
    // Определяем тип ресурса
    const resourceType = mimeType && mimeType.startsWith('video/') ? 'video' : 'image';
    
    // Загружаем в Cloudinary
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: folder,
          resource_type: resourceType,
          use_filename: true,
          unique_filename: true,
          public_id: crypto.randomUUID() + '_' + path.parse(originalName).name,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(fileBuffer);
    });

    console.log(`✅ Файл загружен в Cloudinary: ${result.public_id}`);
    console.log(`📎 URL: ${result.secure_url}`);

    // Удаляем локальный файл
    if (fs.existsSync(publicPath)) {
      fs.unlinkSync(publicPath);
      console.log(`🗑️ Локальный файл удален (загружен в Cloudinary)`);
    }

    return result.secure_url;
    
  } catch (error) {
    console.error('❌ Ошибка загрузки в Cloudinary:', error);
    console.log(`📁 Файл оставлен локально: ${publicPath}`);
    return `/${folder}/${originalName}`;
  }
}

// ===== УДАЛЕНИЕ ФАЙЛА ИЗ CLOUDINARY =====
async function deleteFile(fileUrl) {
  if (!fileUrl) return;
  
  // Если локальный файл
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
    // Извлекаем public_id из URL
    const url = new URL(fileUrl);
    const pathParts = url.pathname.split('/');
    const publicId = pathParts.slice(pathParts.indexOf('upload') + 2).join('/');
    const publicIdWithoutExt = publicId.replace(/\.[^/.]+$/, '');
    
    await cloudinary.uploader.destroy(publicIdWithoutExt);
    console.log(`🗑️ Файл удален из Cloudinary: ${publicIdWithoutExt}`);
  } catch (error) {
    console.error('❌ Ошибка удаления из Cloudinary:', error);
  }
}

// ===== ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ФАЙЛЕ =====
async function getFileInfo(publicId) {
  if (!IS_CONFIGURED) return null;
  try {
    const result = await cloudinary.api.resource(publicId);
    return result;
  } catch (error) {
    console.error('❌ Ошибка получения информации:', error);
    return null;
  }
}

module.exports = {
  uploadFile,
  deleteFile,
  getFileInfo,
  isConfigured: IS_CONFIGURED,
};