require('dotenv').config();
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SERVER_URL = process.env.SERVER_URL;
const API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const WEBHOOK_URL = `${SERVER_URL}/webhook/${TELEGRAM_TOKEN}`;

async function setupWebhook() {
  try {
    console.log('🔄 Настройка webhook...');
    console.log('URL:', WEBHOOK_URL);
    
    const response = await axios.post(`${API_URL}/setWebhook`, {
      url: WEBHOOK_URL,
      allowed_updates: ['message', 'callback_query']
    });
    
    if (response.data.ok) {
      console.log('✅ Webhook настроен успешно');
      
      // Проверяем статус
      const info = await axios.get(`${API_URL}/getWebhookInfo`);
      console.log('📋 Статус webhook:', info.data.result);
      
    } else {
      console.error('❌ Ошибка:', response.data);
    }
    
  } catch (error) {
    console.error('❌ Ошибка настройки webhook:', error.message);
  }
}

setupWebhook();
