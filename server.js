const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const seedrandom = require('seedrandom');

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const ONE_HOUR = 3600000;

// =================================
// 메모리 저장
// =================================
let MASTER_QUIZ_DATA = [];
let LAST_FETCH_TIME = 0;
let LAST_FAILURE_TIME = 0;

// =================================
// fallback 퀴즈
// =================================
const FALLBACK_QUIZ = [
  {
    id: 1,
    topic: "기본",
    question: "대한민국 수도는?",
    choices: ["서울", "부산", "대구", "인천"],
    correctAnswerIndex: 0,
    explanation: "정답은 서울입니다."
  }
];

// =================================
// 퀴즈 프롬프트
// =================================
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
    contents:[{
      role:"user",
      parts:[{
        text:`5개 분야에서 각 1문제씩 총 5문제 생성.
분야: ${batch.join(", ")}
JSON 배열만 반환:
[
  {
    "topic":"...",
    "question":"...",
    "choices":["A","B","C","D"],
    "correctAnswerIndex":0,
    "explanation":"정답은 A입니다..."
  }
]`
      }]
    }],
    generationConfig:{ responseMimeType:"application/json", temperature:0.8 }
  };
}

// =================================
// 유틸
// =================================
function assignQuizIds(data){ return data.map((q,i)=>({...q,id:i+1})); }
function getDailySeed(){ const d=new Date(); return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`; }
function shuffleArray(array, seed){ const rng = seedrandom(seed); for(let i=array.length-1;i>0;i--){const j=Math.floor(rng()*(i+1)); [array[i],array[j]]=[array[j],array[i]];} return array; }
function getKRandomQuestions(K, master){ return shuffleArray([...master], getDailySeed()).slice(0,K); }
function sanitizeQuizData(qs){ return qs.map(({correctAnswerIndex,...safe})=>safe); }

// =================================
// Gemini API 호출
// =================================
async function fetchNewQuizData(){
  const prompt = getNextPrompt();
  const MAX_RETRIES = 2;
  let success=false;

  for(let attempt=0; attempt<=MAX_RETRIES; attempt++){
    try{
      const res = await axios.post(GEMINI_API_URL,prompt,{timeout:30000});
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if(!text) throw new Error("EMPTY_RESPONSE");

      const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());

      if(Array.isArray(parsed) && parsed.length>=3){
        MASTER_QUIZ_DATA = assignQuizIds(parsed);
        LAST_FETCH_TIME = Date.now();
        success=true;
        console.log("[DATA] quiz loaded:", MASTER_QUIZ_DATA.length);
        break;
      }

      throw new Error("BAD_DATA");

    }catch(err){
      const status = err.response?.status;
      if(status===429){ console.error("[429] rate limit"); break; }
      console.error("[FETCH ERROR]", err.message, `(attempt ${attempt+1})`);
      if(attempt<MAX_RETRIES) await new Promise(r=>setTimeout(r,Math.pow(2,attempt)*1000));
    }
  }

  if(!success) LAST_FAILURE_TIME = Date.now();
  return success;
}

// =================================
// 데이터 갱신 체크
// =================================
async function ensureDataFreshness(){
  const now=Date.now();
  const stale=(now-LAST_FETCH_TIME)>ONE_HOUR;
  const recentFail=(now-LAST_FAILURE_TIME)<300000;

  if(recentFail) return;
  if(MASTER_QUIZ_DATA.length===0 || stale){
    console.log("[CHECK] Data stale or missing. Refreshing...");
    const ok = await fetchNewQuizData();
    if(!ok){
      console.log("[FALLBACK] using fallback quiz");
      MASTER_QUIZ_DATA = FALLBACK_QUIZ;
    }
  }
}

// =================================
// routes
// =================================
app.get('/',(req,res)=>{
  res.sendFile(path.join(__dirname,'index.html'));
});

app.get('/api/quiz', async (req,res)=>{
  try{
    await ensureDataFreshness();
    const qs = getKRandomQuestions(5, MASTER_QUIZ_DATA);
    res.json(sanitizeQuizData(qs));
  }catch(err){
    console.error(err);
    res.json(sanitizeQuizData(FALLBACK_QUIZ));
  }
});

app.get('/api/answer-key', async (req,res)=>{
  try{
    const qs = getKRandomQuestions(5, MASTER_QUIZ_DATA);
    const key = {};
    qs.forEach(q=>{ key[q.id]=q.correctAnswerIndex; });
    res.json(key);
  }catch{
    res.json({});
  }
});

module.exports = app;
