require('dotenv').config();

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const {SessionsClient} = require('@google-cloud/dialogflow-cx');

// Конфигурация
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SERVER_URL = process.env.SERVER_URL;
const PROJECT_ID = process.env.PROJECT_ID;
const LOCATION_ID = process.env.LOCATION_ID;
const AGENT_ID = process.env.AGENT_ID;
const LANGUAGE_CODE = process.env.LANGUAGE_CODE;

const API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const URI = `/webhook/${TELEGRAM_TOKEN}`;
const WEBHOOK = SERVER_URL + URI;

// Express приложение
const app = express();
app.use(bodyParser.json());

// Dialogflow CX клиент
const client = new SessionsClient({
  apiEndpoint: LOCATION_ID + '-dialogflow.googleapis.com'
});

// Хранилище пользовательских сессий
const userSessions = new Map();

// Функция для обработки команд страниц
function isPageCommand(text) {
  const pagePatterns = [
    /покажи\s+страниц[уа]\s+(\d+)/i,
    /стр\.?\s+(\d+)/i,
    /страниц[уа]\s+(\d+)/i,
    /page\s+(\d+)/i
  ];
  
  for (const pattern of pagePatterns) {
    const match = text.match(pattern);
    if (match) {
      return parseInt(match[1]);
    }
  }
  return null;
}

// Парсинг ответа от Dialogflow CX для извлечения отелей
function parseHotelsFromResponse(responseText) {
  console.log('🔍 Parsing response:', responseText);
  
  const hotels = [];
  
  try {
    // Ищем общее количество отелей
    const totalMatch = responseText.match(/Найдено\s+(\d+)\s+отел[ейя]/i);
    const totalHotels = totalMatch ? parseInt(totalMatch[1]) : 0;
    
    console.log('📊 Total hotels found:', totalHotels);
    
    // Парсим отели по блокам HOTEL_PHOTO, HOTEL_INFO, HOTEL_ID
    const lines = responseText.split('\n');
    let currentHotel = {};
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.startsWith('HOTEL_PHOTO:')) {
        // Сохраняем предыдущий отель если есть
        if (currentHotel.photo && currentHotel.name) {
          hotels.push({...currentHotel});
        }
        
        // Начинаем новый отель
        currentHotel = {
          photo: line.replace('HOTEL_PHOTO:', '').trim(),
          name: 'Отель',
          price: 0,
          stars: 0,
          place: 'Анталия',
          id: `hotel_${Date.now()}_${hotels.length}`
        };
      }
      else if (line.startsWith('HOTEL_INFO:') && currentHotel.photo) {
        const info = line.replace('HOTEL_INFO:', '').trim();
        // Парсим: "Название - цена USD (звезды⭐)"
        const match = info.match(/(.+?)\s*-\s*(\d+)\s*USD\s*\((\d+)⭐\)/);
        if (match) {
          currentHotel.name = match[1].trim();
          currentHotel.price = parseInt(match[2]);
          currentHotel.stars = parseInt(match[3]);
        } else {
          // Fallback если формат другой
          currentHotel.name = info;
        }
      }
      else if (line.startsWith('HOTEL_ID:') && currentHotel.photo) {
        currentHotel.id = line.replace('HOTEL_ID:', '').trim();
      }
    }
    
    // Добавляем последний отель
    if (currentHotel.photo && currentHotel.name) {
      hotels.push({...currentHotel});
    }
    
    console.log(`✅ Parsed ${hotels.length} hotels successfully`);
    
    // Логируем первые несколько отелей для проверки
    if (hotels.length > 0) {
      console.log('🏨 First hotel:', {
        name: hotels[0].name,
        price: hotels[0].price,
        photo: hotels[0].photo.substring(0, 50) + '...'
      });
    }
    
  } catch (error) {
    console.error('❌ Parsing error:', error);
  }
  
  return hotels;
}

// Создание карточки отеля
function createHotelCard(hotel, hotelIndex, totalHotels, currentPage = 1, totalPages = null) {
  const stars = '⭐'.repeat(hotel.stars || 0);
  
  const caption = `🏨 *${hotel.name}*\n\n${stars} ${hotel.stars || 0} звезд\n💰 *${hotel.price} USD* за ночь\n📍 ${hotel.place || 'Анталия'}\n\n📋 Отель ${hotelIndex + 1} из ${totalHotels}`;
  
  const keyboard = [];
  
  // Навигация по отелям в текущем списке
  const navRow = [];
  if (hotelIndex > 0) {
    navRow.push({ text: '⬅️ Предыдущий', callback_data: `hotel_${hotelIndex - 1}` });
  }
  if (hotelIndex < totalHotels - 1) {
    navRow.push({ text: 'Следующий ➡️', callback_data: `hotel_${hotelIndex + 1}` });
  }
  if (navRow.length > 0) {
    keyboard.push(navRow);
  }
  
  // Навигация по страницам
  const pageRow = [];
  if (currentPage > 1) {
    pageRow.push({ text: '⬅️ Пред. страница', callback_data: `page_${currentPage - 1}` });
  }
  
  // Показываем информацию о текущей странице
  const pageInfo = totalPages ? `📄 Стр. ${currentPage}/${totalPages}` : `📄 Стр. ${currentPage}`;
  pageRow.push({ text: pageInfo, callback_data: 'current_page' });
  
  // Всегда показываем кнопку "следующая страница" 
  pageRow.push({ text: 'След. страница ➡️', callback_data: `page_${currentPage + 1}` });
  keyboard.push(pageRow);
  
  // Кнопки действий
  keyboard.push([
    { text: '📞 Связаться с менеджером', callback_data: `contact_${hotel.id}` },
    { text: '📋 Подробнее об отеле', callback_data: `detail_${hotel.id}` }
  ]);
  
  keyboard.push([
    { text: '🔍 Новый поиск', callback_data: 'new_search' }
  ]);
  
  return {
    photo: hotel.photo,
    caption: caption,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: keyboard
    }
  };
}

// Функция для обработки HTML тегов
function processHtmlTags(text) {
  let cleanText = text;
  
  // Заменяем HTML теги на Markdown и очищаем
  cleanText = cleanText
    .replace(/<br\s*\/?>/gi, '\n')                    // <br> -> новая строка
    .replace(/<\/p>/gi, '\n\n')                       // </p> -> двойной перенос
    .replace(/<p[^>]*>/gi, '')                        // удаляем открывающий <p>
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '*$1*') // <strong> -> жирный
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '*$1*')          // <b> -> жирный
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '_$1_')        // <em> -> курсив
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '_$1_')          // <i> -> курсив
    .replace(/<li[^>]*>/gi, '• ')                     // <li> -> маркер списка
    .replace(/<\/li>/gi, '\n')                        // </li> -> новая строка
    .replace(/<ul[^>]*>/gi, '\n')                     // <ul> -> новая строка
    .replace(/<\/ul>/gi, '\n')                        // </ul> -> новая строка
    .replace(/<[^>]*>/g, '')                          // удаляем остальные HTML теги
    .replace(/\n{3,}/g, '\n\n')                       // убираем лишние переносы
    .replace(/^\s+|\s+$/gm, '')                       // убираем пробелы в начале/конце строк
    .trim();
  
  return cleanText;
}

// Парсинг деталей отеля из ответа DialogFlow
function parseHotelDetails(responseText) {
  console.log('🔍 Parsing hotel details:', responseText.substring(0, 200));
  
  let hotelDetails = {
    name: '',
    place: '',
    star: 0,
    img: '',
    description: {}
  };
  
  try {
    // Извлекаем название отеля
    const nameMatch = responseText.match(/\*\*([^*]+)\*\*/);
    if (nameMatch) {
      hotelDetails.name = nameMatch[1];
    }
    
    // Извлекаем место
    const placeMatch = responseText.match(/\*\*Местоположение:\*\*\s*([^\n]+)/);
    if (placeMatch) {
      hotelDetails.place = placeMatch[1];
    }
    
    // Извлекаем звезды (если есть)
    const starMatch = responseText.match(/(\d+)\s*звезд/);
    if (starMatch) {
      hotelDetails.star = parseInt(starMatch[1]);
    }
    
    // Извлекаем URL изображения
    const imgMatch = responseText.match(/\[URL изображения:\s*(https?:\/\/[^\]]+)\]/);
    if (imgMatch) {
      hotelDetails.img = imgMatch[1];
    }
    
    // Извлекаем описание отеля
    const descMatch = responseText.match(/\*\*Описание:\*\*\s*([^*]+?)(?=\*\*|$)/s);
    if (descMatch) {
      hotelDetails.description.location = descMatch[1].trim();
    }
    
    // Извлекаем удобства
    const amenitiesMatch = responseText.match(/\*\*Удобства:\*\*\s*([^*]+?)(?=\*\*|$)/s);
    if (amenitiesMatch) {
      hotelDetails.description.amenities = amenitiesMatch[1].trim();
    }
    
    // Извлекаем информацию о номерах
    const roomsMatch = responseText.match(/\*\*Номера:\*\*\s*([^*]+?)(?=\*\*|$)/s);
    if (roomsMatch) {
      hotelDetails.description.rooms = roomsMatch[1].trim();
    }
    
    // Извлекаем бизнес-удобства
    const businessMatch = responseText.match(/\*\*Бизнес-удобства:\*\*\s*([^*]+?)(?=\*\*|$)/s);
    if (businessMatch) {
      hotelDetails.description.business_amenities = businessMatch[1].trim();
    }
    
    // Извлекаем достопримечательности
    const attractionsMatch = responseText.match(/\*\*Достопримечательности:\*\*\s*([\s\S]*?)(?=\*\*|Ближайший|$)/);
    if (attractionsMatch) {
      hotelDetails.description.attractions = attractionsMatch[1].trim();
    }
    
    console.log('✅ Parsed hotel details:', {
      name: hotelDetails.name,
      place: hotelDetails.place,
      star: hotelDetails.star,
      hasImage: !!hotelDetails.img
    });
    
  } catch (error) {
    console.error('❌ Error parsing hotel details:', error);
  }
  
  return hotelDetails;
}

// Форматирование деталей отеля для отправки в Telegram
function formatHotelDetailsForTelegram(hotelDetails, originalText) {
  let formattedText = '';
  
  // Название отеля
  if (hotelDetails.name) {
    formattedText += `🏨 *${hotelDetails.name}*\n\n`;
  }
  
  // Место и звезды
  if (hotelDetails.place) {
    formattedText += `📍 *Местоположение:* ${hotelDetails.place}\n`;
  }
  
  if (hotelDetails.star > 0) {
    const stars = '⭐'.repeat(hotelDetails.star);
    formattedText += `${stars} ${hotelDetails.star} звезд\n`;
  }
  
  formattedText += '\n';
  
  // Описание и местоположение
  if (hotelDetails.description.location) {
    formattedText += `📋 *Описание:*\n${processHtmlTags(hotelDetails.description.location)}\n\n`;
  }
  
  // Удобства
  if (hotelDetails.description.amenities) {
    formattedText += `🏪 *Удобства:*\n${processHtmlTags(hotelDetails.description.amenities)}\n\n`;
  }
  
  // Номера
  if (hotelDetails.description.rooms) {
    formattedText += `🛏 *Номера:*\n${processHtmlTags(hotelDetails.description.rooms)}\n\n`;
  }
  
  // Бизнес-удобства
  if (hotelDetails.description.business_amenities) {
    formattedText += `💼 *Бизнес-удобства:*\n${processHtmlTags(hotelDetails.description.business_amenities)}\n\n`;
  }
  
  // Достопримечательности
  if (hotelDetails.description.attractions) {
    formattedText += `🗺 *Достопримечательности:*\n${processHtmlTags(hotelDetails.description.attractions)}\n\n`;
  }
  
  // Если ничего не удалось извлечь, используем оригинальный текст
  if (!formattedText.trim()) {
    formattedText = processHtmlTags(originalText);
  }
  
  return formattedText;
}

// Отправка запроса в Dialogflow CX для деталей отеля
async function queryDialogflowForHotelDetails(text, sessionId) {
  try {
    const sessionPath = client.projectLocationAgentSessionPath(
      PROJECT_ID, LOCATION_ID, AGENT_ID, sessionId
    );
    
    console.log(`📤 Запрос деталей отеля:`, { text, sessionId });
    
    const request = {
      session: sessionPath,
      queryInput: {
        text: {
          text: text
        },
        languageCode: LANGUAGE_CODE
      }
    };
    
    const [response] = await client.detectIntent(request);
    
    console.log('📥 Ответ от Dialogflow (детали):', {
      intent: response.queryResult.intent?.displayName || 'undefined',
      responseCount: response.queryResult.responseMessages?.length || 0
    });
    
    return response;
    
  } catch (error) {
    console.error('❌ Ошибка Dialogflow (детали):', error);
    throw error;
  }
}

// Отправка запроса в Dialogflow CX с параметрами страницы
async function queryDialogflowForHotels(text, sessionId, page = 1) {
  try {
    const sessionPath = client.projectLocationAgentSessionPath(
      PROJECT_ID, LOCATION_ID, AGENT_ID, sessionId
    );
    
    console.log(`📤 Запрос отелей стр. ${page}:`, { text, sessionId });
    
    // Формируем текст с указанием страницы
    let queryText = text;
    if (page > 1) {
      queryText = `покажи страницу ${page}`;
    }
    
    const request = {
      session: sessionPath,
      queryInput: {
        text: {
          text: queryText
        },
        languageCode: LANGUAGE_CODE
      },
      queryParams: {
        parameters: {
          page: page
        }
      }
    };
    
    const [response] = await client.detectIntent(request);
    
    console.log('📥 Ответ от Dialogflow:', {
      intent: response.queryResult.intent?.displayName || 'undefined',
      responseCount: response.queryResult.responseMessages?.length || 0,
      page: page,
      queryText: queryText
    });
    
    return response;
    
  } catch (error) {
    console.error('❌ Ошибка Dialogflow:', error);
    throw error;
  }
}

// Основной обработчик webhook
app.post(URI, async (req, res) => {
  res.status(200).send('OK');
  
  try {
    console.log('📨 Webhook получен');
    
    // Обработка callback кнопок
    if (req.body.callback_query) {
      const callbackQuery = req.body.callback_query;
      const chatId = callbackQuery.message.chat.id;
      const data = callbackQuery.data;
      
      console.log('🔄 Callback:', data);
      
      // Подтверждаем callback
      await axios.post(`${API_URL}/answerCallbackQuery`, {
        callback_query_id: callbackQuery.id
      });
      
      const userSession = userSessions.get(chatId);
      
      // Навигация по отелям
      if (data.startsWith('hotel_')) {
        const hotelIndex = parseInt(data.split('_')[1]);
        
        if (userSession && userSession.hotels && userSession.hotels[hotelIndex]) {
          const hotel = userSession.hotels[hotelIndex];
          const currentPage = userSession.currentPage || 1;
          
          // Обновляем текущий индекс отеля в сессии
          userSession.currentHotelIndex = hotelIndex;
          userSessions.set(chatId, userSession);
          
          const hotelCard = createHotelCard(hotel, hotelIndex, userSession.hotels.length, currentPage);
          
          try {
            await axios.post(`${API_URL}/editMessageMedia`, {
              chat_id: chatId,
              message_id: callbackQuery.message.message_id,
              media: {
                type: 'photo',
                media: hotelCard.photo,
                caption: hotelCard.caption,
                parse_mode: 'Markdown'
              },
              reply_markup: hotelCard.reply_markup
            });
          } catch (editError) {
            // Если редактирование не удалось, отправляем новое сообщение
            await axios.post(`${API_URL}/sendPhoto`, {
              chat_id: chatId,
              ...hotelCard
            });
          }
        }
        return;
      }
      
      // Навигация по страницам
      if (data.startsWith('page_')) {
        const newPage = parseInt(data.split('_')[1]);
        
        console.log(`🔄 Запрос страницы ${newPage}`);
        
        // Показываем индикатор загрузки
        await axios.post(`${API_URL}/sendChatAction`, {
          chat_id: chatId,
          action: 'typing'
        });
        
        try {
          // Запрашиваем новую страницу отелей через Dialogflow
          const lastSearchText = userSession?.lastSearchText || 'найди отели';
          const response = await queryDialogflowForHotels(lastSearchText, chatId, newPage);
          
          if (response.queryResult.responseMessages) {
            const responseText = response.queryResult.responseMessages
              .map(msg => msg.text ? msg.text.text.join('') : '')
              .join('\n');
            
            console.log('📝 Response text for page:', responseText.substring(0, 200));
            
            const hotels = parseHotelsFromResponse(responseText);
            
            if (hotels.length > 0) {
              // Обновляем сессию с новыми отелями и страницей
              userSession.hotels = hotels;
              userSession.currentHotelIndex = 0;
              userSession.currentPage = newPage;
              userSessions.set(chatId, userSession);
              
              // Показываем первый отель с новой страницы
              const hotelCard = createHotelCard(hotels[0], 0, hotels.length, newPage);
              
              try {
                await axios.post(`${API_URL}/editMessageMedia`, {
                  chat_id: chatId,
                  message_id: callbackQuery.message.message_id,
                  media: {
                    type: 'photo',
                    media: hotelCard.photo,
                    caption: hotelCard.caption,
                    parse_mode: 'Markdown'
                  },
                  reply_markup: hotelCard.reply_markup
                });
              } catch (editError) {
                await axios.post(`${API_URL}/sendPhoto`, {
                  chat_id: chatId,
                  ...hotelCard
                });
              }
              
              // Информационное сообщение
              await axios.post(`${API_URL}/sendMessage`, {
                chat_id: chatId,
                text: `✅ Страница ${newPage} - найдено ${hotels.length} отелей`
              });
              
            } else {
              await axios.post(`${API_URL}/sendMessage`, {
                chat_id: chatId,
                text: `❌ На странице ${newPage} отели не найдены`
              });
            }
          }
        } catch (pageError) {
          console.error('❌ Ошибка получения страницы:', pageError);
          await axios.post(`${API_URL}/sendMessage`, {
            chat_id: chatId,
            text: `❌ Ошибка загрузки страницы ${newPage}. Попробуйте еще раз.`
          });
        }
        return;
      }
      
      // Возврат к списку отелей
      if (data === 'back_to_list') {
        const userSession = userSessions.get(chatId);
        
        if (userSession && userSession.hotels && userSession.hotels.length > 0) {
          // Возвращаемся к текущему отелю в списке
          const currentIndex = userSession.currentHotelIndex || 0;
          const hotel = userSession.hotels[currentIndex];
          const currentPage = userSession.currentPage || 1;
          
          console.log(`🔄 Возврат к списку отелей: отель ${currentIndex + 1}/${userSession.hotels.length}, страница ${currentPage}`);
          
          const hotelCard = createHotelCard(hotel, currentIndex, userSession.hotels.length, currentPage);
          
          try {
            await axios.post(`${API_URL}/sendPhoto`, {
              chat_id: chatId,
              ...hotelCard
            });
          } catch (photoError) {
            await axios.post(`${API_URL}/sendMessage`, {
              chat_id: chatId,
              text: `🏨 ${hotelCard.caption}\n\n📷 Фото: ${hotelCard.photo || 'недоступно'}`,
              parse_mode: hotelCard.parse_mode,
              reply_markup: hotelCard.reply_markup
            });
          }
          
          await axios.post(`${API_URL}/sendMessage`, {
            chat_id: chatId,
            text: `↩️ Вы вернулись к списку отелей (стр. ${currentPage})`
          });
          
        } else {
          await axios.post(`${API_URL}/sendMessage`, {
            chat_id: chatId,
            text: '❌ Список отелей не найден. Начните новый поиск.',
            reply_markup: {
              inline_keyboard: [[
                { text: '🔍 Новый поиск', callback_data: 'new_search' }
              ]]
            }
          });
        }
        return;
      }
      
      // Связь с менеджером
      if (data.startsWith('contact_')) {
        await axios.post(`${API_URL}/sendMessage`, {
          chat_id: chatId,
          text: `📞 *Свяжитесь с менеджером*\n\n👤 Telegram: @asialuxe_manager\n\n⏰ Ответим в течение 15 минут`,
          parse_mode: 'Markdown'
        });
        return;
      }
      
      // Детали отеля
      if (data.startsWith('detail_')) {
        const hotelId = data.split('_')[1];
        
        console.log(`🏨 Запрос деталей отеля ID: ${hotelId}`);
        
        // Показываем индикатор загрузки
        await axios.post(`${API_URL}/sendChatAction`, {
          chat_id: chatId,
          action: 'typing'
        });
        
        try {
          // Отправляем запрос в Dialogflow для получения деталей отеля
          const response = await queryDialogflowForHotelDetails(`покажи подробнее об отеле ${hotelId}`, chatId);
          
          if (response.queryResult.responseMessages) {
            const responseText = response.queryResult.responseMessages
              .map(msg => msg.text ? msg.text.text.join('') : '')
              .join('\n');
            
            console.log('📝 Детали отеля получены:', responseText.substring(0, 200));
            
            // Парсим детали отеля
            const hotelDetails = parseHotelDetails(responseText);
            
            // Форматируем для Telegram
            const formattedText = formatHotelDetailsForTelegram(hotelDetails, responseText);
            
            // Добавляем кнопку "Назад к списку" если есть активная сессия
            const userSession = userSessions.get(chatId);
            let replyMarkup = null;
            
            if (userSession && userSession.hotels && userSession.hotels.length > 0) {
              replyMarkup = {
                inline_keyboard: [
                  [
                    { text: '⬅️ Назад к списку отелей', callback_data: `back_to_list` }
                  ],
                  [
                    { text: '📞 Связаться с менеджером', callback_data: `contact_${hotelId}` }
                  ]
                ]
              };
            } else {
              replyMarkup = {
                inline_keyboard: [
                  [
                    { text: '📞 Связаться с менеджером', callback_data: `contact_${hotelId}` }
                  ],
                  [
                    { text: '🔍 Новый поиск', callback_data: 'new_search' }
                  ]
                ]
              };
            }
            
            // Отправляем детали отеля с изображением если есть
            if (hotelDetails.img) {
              try {
                await axios.post(`${API_URL}/sendPhoto`, {
                  chat_id: chatId,
                  photo: hotelDetails.img,
                  caption: formattedText,
                  parse_mode: 'Markdown',
                  reply_markup: replyMarkup
                });
              } catch (photoError) {
                console.log('⚠️ Ошибка отправки фото, отправляем как текст');
                await axios.post(`${API_URL}/sendMessage`, {
                  chat_id: chatId,
                  text: formattedText + `\n\n📷 Фото: ${hotelDetails.img}`,
                  parse_mode: 'Markdown',
                  reply_markup: replyMarkup
                });
              }
            } else {
              await axios.post(`${API_URL}/sendMessage`, {
                chat_id: chatId,
                text: formattedText,
                parse_mode: 'Markdown',
                reply_markup: replyMarkup
              });
            }
            
          } else {
            await axios.post(`${API_URL}/sendMessage`, {
              chat_id: chatId,
              text: '❌ Не удалось получить детальную информацию об отеле'
            });
          }
        } catch (detailError) {
          console.error('❌ Ошибка получения деталей отеля:', detailError);
          await axios.post(`${API_URL}/sendMessage`, {
            chat_id: chatId,
            text: '❌ Ошибка получения информации об отеле. Попробуйте еще раз.'
          });
        }
        return;
      }
      
      // Новый поиск
      if (data === 'new_search') {
        userSessions.delete(chatId);
        await axios.post(`${API_URL}/sendMessage`, {
          chat_id: chatId,
          text: `🔍 *Новый поиск отелей в Анталии*\n\nНапишите даты и количество человек\n\nПример: "отель с 25 по 30 декабря для 2 взрослых"`,
          parse_mode: 'Markdown'
        });
        return;
      }
      
      return;
    }
    
// Обработка текстовых сообщений
   if (!req.body?.message?.text) {
     return;
   }
   
   const chatId = req.body.message.chat.id;
   const messageText = req.body.message.text;
   
   console.log('💬 Сообщение:', messageText);
   
   // Команда /start
   if (messageText === '/start') {
     await axios.post(`${API_URL}/sendMessage`, {
       chat_id: chatId,
       text: `🏨 *Поиск отелей в Анталии*\n\n👋 Привет! Я помогу найти отель в Анталии\n\n✨ Просто напишите:\n• "найди отель завтра на неделю"\n• "отель с 25 декабря по 1 января"\n• "отель на выходные для 2 человек"\n• "покажи страницу 2" - для навигации\n• "подробнее об отеле 12345" - детали отеля`,
       parse_mode: 'Markdown'
     });
     return;
   }
   
   // Проверяем, является ли это командой деталей отеля
   const hotelDetailMatch = messageText.match(/подробнее\s+об\s+отеле\s+(\d+)|детали\s+отеля\s+(\d+)|отель\s+(\d+)\s+подробнее/i);
   if (hotelDetailMatch) {
     const hotelId = hotelDetailMatch[1] || hotelDetailMatch[2] || hotelDetailMatch[3];
     
     console.log(`🏨 Текстовый запрос деталей отеля ID: ${hotelId}`);
     
     await axios.post(`${API_URL}/sendChatAction`, {
       chat_id: chatId,
       action: 'typing'
     });
     
     try {
       const response = await queryDialogflowForHotelDetails(`покажи подробнее об отеле ${hotelId}`, chatId);
       
       if (response.queryResult.responseMessages) {
         const responseText = response.queryResult.responseMessages
           .map(msg => msg.text ? msg.text.text.join('') : '')
           .join('\n');
         
         // Парсим детали отеля
         const hotelDetails = parseHotelDetails(responseText);
         
         // Форматируем для Telegram
         const formattedText = formatHotelDetailsForTelegram(hotelDetails, responseText);
         
         // Добавляем кнопку "Назад к списку" если есть активная сессия
         const userSession = userSessions.get(chatId);
         let replyMarkup = null;
         
         if (userSession && userSession.hotels && userSession.hotels.length > 0) {
           replyMarkup = {
             inline_keyboard: [
               [
                 { text: '⬅️ Назад к списку отелей', callback_data: `back_to_list` }
               ],
               [
                 { text: '📞 Связаться с менеджером', callback_data: `contact_${hotelId}` }
               ]
             ]
           };
         } else {
           replyMarkup = {
             inline_keyboard: [
               [
                 { text: '📞 Связаться с менеджером', callback_data: `contact_${hotelId}` }
               ],
               [
                 { text: '🔍 Новый поиск', callback_data: 'new_search' }
               ]
             ]
           };
         }
         
         // Отправляем детали отеля с изображением если есть
         if (hotelDetails.img) {
           try {
             await axios.post(`${API_URL}/sendPhoto`, {
               chat_id: chatId,
               photo: hotelDetails.img,
               caption: formattedText,
               parse_mode: 'Markdown',
               reply_markup: replyMarkup
             });
           } catch (photoError) {
             console.log('⚠️ Ошибка отправки фото, отправляем как текст');
             await axios.post(`${API_URL}/sendMessage`, {
               chat_id: chatId,
               text: formattedText + `\n\n📷 Фото: ${hotelDetails.img}`,
               parse_mode: 'Markdown',
               reply_markup: replyMarkup
             });
           }
         } else {
           await axios.post(`${API_URL}/sendMessage`, {
             chat_id: chatId,
             text: formattedText,
             parse_mode: 'Markdown',
             reply_markup: replyMarkup
           });
         }
       } else {
         await axios.post(`${API_URL}/sendMessage`, {
           chat_id: chatId,
           text: '❌ Не удалось получить детальную информацию об отеле'
         });
       }
     } catch (error) {
       console.error('❌ Ошибка получения деталей отеля через текст:', error);
       await axios.post(`${API_URL}/sendMessage`, {
         chat_id: chatId,
         text: '❌ Ошибка получения информации об отеле. Попробуйте еще раз.'
       });
     }
     return;
   }
   
   // Проверяем, является ли это командой страницы
   const requestedPage = isPageCommand(messageText);
   const userSession = userSessions.get(chatId);
   
   if (requestedPage && userSession && userSession.lastSearchText) {
     console.log(`📄 Запрос страницы ${requestedPage} через текст`);
     
     // Показываем индикатор "печатает"
     await axios.post(`${API_URL}/sendChatAction`, {
       chat_id: chatId,
       action: 'typing'
     });
     
     try {
       const response = await queryDialogflowForHotels(userSession.lastSearchText, chatId, requestedPage);
       
       if (response.queryResult.responseMessages) {
         const responseText = response.queryResult.responseMessages
           .map(msg => msg.text ? msg.text.text.join('') : '')
           .join('\n');
         
         const hotels = parseHotelsFromResponse(responseText);
         
         if (hotels.length > 0) {
           // Обновляем сессию
           userSession.hotels = hotels;
           userSession.currentHotelIndex = 0;
           userSession.currentPage = requestedPage;
           userSessions.set(chatId, userSession);
           
           // Отправляем первый отель
           const hotelCard = createHotelCard(hotels[0], 0, hotels.length, requestedPage);
           
           try {
             await axios.post(`${API_URL}/sendPhoto`, {
               chat_id: chatId,
               ...hotelCard
             });
           } catch (photoError) {
             await axios.post(`${API_URL}/sendMessage`, {
               chat_id: chatId,
               text: `🏨 ${hotelCard.caption}\n\n📷 Фото: ${hotelCard.photo || 'недоступно'}`,
               parse_mode: hotelCard.parse_mode,
               reply_markup: hotelCard.reply_markup
             });
           }
           
           await axios.post(`${API_URL}/sendMessage`, {
             chat_id: chatId,
             text: `✅ Страница ${requestedPage} - найдено ${hotels.length} отелей`
           });
           
         } else {
           await axios.post(`${API_URL}/sendMessage`, {
             chat_id: chatId,
             text: `❌ На странице ${requestedPage} отели не найдены`
           });
         }
       }
     } catch (error) {
       console.error('❌ Ошибка получения страницы через текст:', error);
       await axios.post(`${API_URL}/sendMessage`, {
         chat_id: chatId,
         text: `❌ Ошибка загрузки страницы ${requestedPage}. Попробуйте еще раз.`
       });
     }
     return;
   }
   
   // Показываем индикатор "печатает"
   await axios.post(`${API_URL}/sendChatAction`, {
     chat_id: chatId,
     action: 'typing'
   });
   
   // Отправляем запрос в Dialogflow CX
   const response = await queryDialogflowForHotels(messageText, chatId, 1);
   
   // Обрабатываем ответ
   if (response.queryResult.responseMessages) {
     const responseText = response.queryResult.responseMessages
       .map(msg => msg.text ? msg.text.text.join('') : '')
       .join('\n');
     
     console.log('📝 Полный ответ от Dialogflow:', responseText);
     
     // Парсим отели из ответа
     const hotels = parseHotelsFromResponse(responseText);
     
     if (hotels.length > 0) {
       // Сохраняем отели в сессии
       userSessions.set(chatId, {
         hotels: hotels,
         currentHotelIndex: 0,
         currentPage: 1,
         lastSearchText: messageText
       });
       
       // Отправляем первый отель
       try {
         const hotelCard = createHotelCard(hotels[0], 0, hotels.length, 1);
         
         // Проверяем URL фото
         if (hotelCard.photo && hotelCard.photo.startsWith('http')) {
           await axios.post(`${API_URL}/sendPhoto`, {
             chat_id: chatId,
             ...hotelCard
           });
         } else {
           // Если фото недоступно, отправляем как текст
           await axios.post(`${API_URL}/sendMessage`, {
             chat_id: chatId,
             text: hotelCard.caption,
             parse_mode: hotelCard.parse_mode,
             reply_markup: hotelCard.reply_markup
           });
         }
         
       } catch (photoError) {
         console.log('⚠️ Photo error, sending as text:', photoError.message);
         
         // Fallback - отправляем как текстовое сообщение
         const hotelCard = createHotelCard(hotels[0], 0, hotels.length, 1);
         await axios.post(`${API_URL}/sendMessage`, {
           chat_id: chatId,
           text: `🏨 ${hotelCard.caption}\n\n📷 Фото: ${hotelCard.photo || 'недоступно'}`,
           parse_mode: hotelCard.parse_mode,
           reply_markup: hotelCard.reply_markup
         });
       }
       
       // Информационное сообщение
       await axios.post(`${API_URL}/sendMessage`, {
         chat_id: chatId,
         text: `✅ Найдено ${hotels.length} отелей на этой странице\n\n👆 Используйте кнопки для навигации или напишите "покажи страницу X"`
       });
       
     } else {
       // Обычный текстовый ответ
       await axios.post(`${API_URL}/sendMessage`, {
         chat_id: chatId,
         text: responseText || 'Не понял ваш запрос. Попробуйте еще раз.'
       });
     }
   } else {
     await axios.post(`${API_URL}/sendMessage`, {
       chat_id: chatId,
       text: 'Извините, произошла ошибка. Попробуйте еще раз.'
     });
   }
   
 } catch (error) {
   console.error('❌ Ошибка webhook:', error);
   
   const chatId = req.body?.message?.chat?.id || req.body?.callback_query?.message?.chat?.id;
   if (chatId) {
     try {
       await axios.post(`${API_URL}/sendMessage`, {
         chat_id: chatId,
         text: '⚠️ Произошла ошибка. Попробуйте еще раз или обратитесь к @asialuxe_manager'
       });
     } catch (sendError) {
       console.error('❌ Ошибка отправки сообщения об ошибке:', sendError);
     }
   }
 }
});

// Настройка webhook
async function setupWebhook() {
 try {
   const response = await axios.post(`${API_URL}/setWebhook`, {
     url: WEBHOOK,
     allowed_updates: ['message', 'callback_query']
   });
   console.log('✅ Webhook настроен:', response.data);
 } catch (error) {
   console.error('❌ Ошибка настройки webhook:', error.message);
 }
}

// Запуск сервера
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
 console.log(`🚀 Сервер запущен на порту ${PORT}`);
 console.log(`🔗 Webhook URL: ${WEBHOOK}`);
 setupWebhook();
});

module.exports = app;