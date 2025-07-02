require('dotenv').config();
const {SessionsClient} = require('@google-cloud/dialogflow-cx');

const PROJECT_ID = process.env.PROJECT_ID;
const LOCATION_ID = process.env.LOCATION_ID;
const AGENT_ID = process.env.AGENT_ID;
const LANGUAGE_CODE = process.env.LANGUAGE_CODE;

const client = new SessionsClient({
  apiEndpoint: LOCATION_ID + '-dialogflow.googleapis.com'
});

async function testDialogflow() {
  try {
    const sessionId = 'test-session-123';
    const sessionPath = client.projectLocationAgentSessionPath(
      PROJECT_ID, LOCATION_ID, AGENT_ID, sessionId
    );
    
    const testPhrases = [
      'найди отели',
      'отель завтра на неделю',
      'поиск отелей в Анталии',
      'найди мне отель в Анталии на 2взрослых',
      'отель с 25 по 30 декабря',
      'привет'
    ];
    
    for (const text of testPhrases) {
      console.log(`\n🧪 Тестируем: "${text}"`);
      console.log('='.repeat(50));
      
      const request = {
        session: sessionPath,
        queryInput: {
          text: { text: text },
          languageCode: LANGUAGE_CODE
        }
      };
      
      const [response] = await client.detectIntent(request);
      
      console.log('📥 Результат:');
      console.log(`   Intent: ${response.queryResult.intent?.displayName || 'НЕ ОПРЕДЕЛЕН'}`);
      console.log(`   Confidence: ${response.queryResult.intentDetectionConfidence || 0}`);
      console.log(`   Parameters:`, response.queryResult.parameters);
      
      if (response.queryResult.responseMessages && response.queryResult.responseMessages.length > 0) {
        const responseText = response.queryResult.responseMessages
          .map(msg => msg.text ? msg.text.text.join('') : '')
          .join('\n');
        
        console.log(`   Response: ${responseText.substring(0, 200)}...`);
        
        // Проверяем есть ли данные об отелях
        const hasHotelData = responseText.includes('HOTEL_PHOTO') || 
                           responseText.includes('HOTEL_INFO') ||
                           responseText.includes('отел');
        console.log(`   Содержит данные об отелях: ${hasHotelData ? '✅ ДА' : '❌ НЕТ'}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
  } catch (error) {
    console.error('❌ Ошибка тестирования:', error);
  }
}

console.log('🧪 ТЕСТИРОВАНИЕ DIALOGFLOW CX');
console.log('Project:', PROJECT_ID);
console.log('Agent:', AGENT_ID);
testDialogflow();
