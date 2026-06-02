// server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const seedrandom = require('seedrandom');
const app = express();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const ONE_HOUR = 3600000;

let MASTER_QUIZ_DATA = [];
let LAST_FETCH_TIME = 0;
let LAST_FAILURE_TIME = 0;

// ======= 퀴즈 프롬프트 =======
const allTopics = [
  "문화예술","환경","과학","역사","디지털 리터러시","인권 리터러시",
  "한글 맞춤법","코딩","안전 및 건강상식","경제","지리","정치"
];
let usedTopics = [];

function getNextPrompt() {
  if (usedTopics.length >= allTopics.length) usedTopics = [];
  const remaining = allTopics.filter(t => !usedTopics.includes(t));
  const batch = remaining.slice(0,5);
  usedTopics.push(...batch);

  return {
    contents: [{
      role:"user",
      parts:[{
        text: `
당신은 상식 퀴즈 전문 AI입니다. 아래 5가지 분야에서 1문제씩 총 5문제를 생성하세요. 단, 다 쓸때까지 분야 중복 없음.
이번 분야: ${batch.join(", ")}

JSON 배열만 반환:
[
  {
    "topic":"분야명",
    "question":"질문 내용",
    "choices":["보기1","보기2","보기3","보기4"],
    "correctAnswerIndex":0,
    "explanation":"정답은 보기1입니다. 이유..."
  }
]
        `
      }]
    }],
    generationConfig:{ responseMimeType:"application/json", temperature:0.8 }
  };
}

// ======= 유틸 =======
function getDailySeed(){
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}

function shuffleArray(array, seed){
  const rng = seedrandom(seed);
  for(let i=array.length-1;i>0;i--){
    const j = Math.floor(rng()*(i+1));
    [array[i],array[j]]=[array[j],array[i]];
  }
  return array;
}

function assignQuizIds(data){ return data.map((q,i)=>({...q,id:i+1})); }
function getKRandomQuestions(K, master){ return shuffleArray([...master], getDailySeed()).slice(0,K); }
function sanitizeQuizData(qs){ return qs.map(({correctAnswerIndex,...safe})=>safe); }

// ======= API 호출 및 갱신 =======
async function fetchNewQuizData(){
  const prompt = getNextPrompt();
  const MAX_RETRIES = 2;
  let success=false;

  for(let attempt=0; attempt<=MAX_RETRIES; attempt++){
    try{
      const res = await axios.post(GEMINI_API_URL,prompt,{timeout:90000});
      const content = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if(!content) throw new Error("유효한 후보 없음");

      const cleaned = content.replace(/```json|```/g,'').trim();
      const parsed = JSON.parse(cleaned);

      if(Array.isArray(parsed)&&parsed.length>=3){
        MASTER_QUIZ_DATA = assignQuizIds(parsed);
        LAST_FETCH_TIME = Date.now();
        success=true;
        console.log(`[DATA] 퀴즈 ${MASTER_QUIZ_DATA.length}개 갱신 완료`);
        break;
      } else {
        throw new Error("문제 수 부족");
      }
    } catch(err){
      console.error(`[FETCH ERROR] ${err.message} (시도 ${attempt+1})`);
      if(attempt<MAX_RETRIES) await new Promise(r=>setTimeout(r,Math.pow(2,attempt)*1000));
    }
  }

  if(!success) LAST_FAILURE_TIME = Date.now();
  return success;
}

async function ensureDataFreshness(){
  const now = Date.now();
  const stale = (now-LAST_FETCH_TIME)>ONE_HOUR;
  const recentFail = (now-LAST_FAILURE_TIME)<300000;

  if(recentFail) return;
  if(MASTER_QUIZ_DATA.length===0 || stale){
    console.log(`[CHECK] Data stale or missing. Refreshing...`);
    await fetchNewQuizData();
  }
}

// ======= 미들웨어 & 라우트 =======
app.use(cors());
app.use(express.json());

app.get('/', (req,res)=>{
  res.sendFile(path.join(__dirname,'index.html'));
});

app.get('/api/quiz', async (req,res)=>{
  await ensureDataFreshness();
  if(MASTER_QUIZ_DATA.length===0) return res.status(503).json({error:"퀴즈 데이터를 가져올 수 없습니다."});
  const qs = getKRandomQuestions(5, MASTER_QUIZ_DATA);
  res.json(sanitizeQuizData(qs));
});

app.get('/api/answer-key', async (req,res)=>{
  await ensureDataFreshness();
  if(MASTER_QUIZ_DATA.length===0) return res.status(503).json({error:"데이터 없음"});
  const qs = getKRandomQuestions(5, MASTER_QUIZ_DATA);
  const key = {};
  qs.forEach(q=>{ key[q.id]=q.correctAnswerIndex; });
  res.json(key);
});

module.exports = app;
