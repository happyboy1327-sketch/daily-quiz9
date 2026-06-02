const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const seedrandom = require('seedrandom');

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const ONE_HOUR = 3600000;

// =====================
// 상태 (Vercel 메모리)
// =====================
let MASTER_QUIZ_DATA = [];
let LAST_FETCH_TIME = 0;
let LAST_FAILURE_TIME = 0;
let INIT_DONE = false;

// =====================
// fallback 12문제
// =====================
const FALLBACK_QUIZ = [
  {id:1,topic:"상식",question:"대한민국 수도는?",choices:["서울","부산","대구","인천"],correctAnswerIndex:0,explanation:"서울입니다"},
  {id:2,topic:"과학",question:"물의 화학식은?",choices:["H2O","CO2","O2","H2"],correctAnswerIndex:0,explanation:"H2O입니다"},
  {id:3,topic:"지리",question:"세계 최대 대륙은?",choices:["아시아","유럽","아프리카","오세아니아"],correctAnswerIndex:0,explanation:"아시아입니다"},
  {id:4,topic:"과학",question:"태양계 가장 큰 행성?",choices:["목성","지구","화성","금성"],correctAnswerIndex:0,explanation:"목성입니다"},
  {id:5,topic:"역사",question:"한국 삼국시대 아닌 나라?",choices:["고구려","신라","백제","조선"],correctAnswerIndex:3,explanation:"조선은 삼국시대 아님"},
  {id:6,topic:"과학",question:"빛의 속도?",choices:["30만km/s","3만km/s","3000km/s","300km/s"],correctAnswerIndex:0,explanation:"30만km/s"},
  {id:7,topic:"지리",question:"일본 수도?",choices:["도쿄","오사카","교토","후쿠오카"],correctAnswerIndex:0,explanation:"도쿄"},
  {id:8,topic:"역사",question:"2차 세계대전 종료?",choices:["1945","1939","1918","1950"],correctAnswerIndex:0,explanation:"1945"},
  {id:9,topic:"과학",question:"식물 광합성 기체?",choices:["이산화탄소","산소","질소","수소"],correctAnswerIndex:0,explanation:"이산화탄소"},
  {id:10,topic:"상식",question:"1년은?",choices:["365일","360일","400일","300일"],correctAnswerIndex:0,explanation:"365일"},
  {id:11,topic:"지리",question:"사하라 사막 위치?",choices:["아프리카","아시아","유럽","남미"],correctAnswerIndex:0,explanation:"아프리카"},
  {id:12,topic:"과학",question:"가장 흔한 혈액형?",choices:["O형","A형","B형","AB형"],correctAnswerIndex:0,explanation:"O형"}
];

// =====================
// 프롬프트
// =====================
const allTopics = [
  "문화예술","환경","과학","역사","디지털 리터러시","인권 리터러시",
  "한글 맞춤법","코딩","안전","경제","지리","정치"
];

let usedTopics = [];

function getNextPrompt() {
  if (usedTopics.length >= allTopics.length) usedTopics = [];

  const remaining = allTopics.filter(t => !usedTopics.includes(t));
  const batch = remaining.slice(0, 5);
  usedTopics.push(...batch);

  return {
    contents: [{
      role: "user",
      parts: [{
        text: `
5개 분야에서 각 1문제씩 총 5문제 생성.

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
]
        `
      }]
    }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.8
    }
  };
}

// =====================
// utils
// =====================
function assignQuizIds(data){
  return data.map((q,i)=>({...q,id:i+1}));
}

function getDailySeed(){
  const d=new Date();
  return `${d.getUTCFullYear()}${d.getUTCMonth()+1}${d.getUTCDate()}`;
}

function shuffle(arr, seed){
  const rng = seedrandom(seed);
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(rng()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

function getQuiz(){
  return shuffle([...MASTER_QUIZ_DATA], getDailySeed()).slice(0,5);
}

function sanitize(data){
  return data.map(({correctAnswerIndex,...rest})=>rest);
}

// =====================
// Gemini fetch
// =====================
async function fetchNewQuizData(){
  const prompt = getNextPrompt();
  let success=false;

  for(let i=0;i<2;i++){
    try{
      const res = await axios.post(GEMINI_API_URL,prompt,{timeout:30000});

      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if(!text) throw new Error("EMPTY");

      const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());

      if(Array.isArray(parsed) && parsed.length>=3){
        MASTER_QUIZ_DATA = assignQuizIds(parsed);
        LAST_FETCH_TIME = Date.now();
        success=true;
        console.log("[OK] quiz loaded:", MASTER_QUIZ_DATA.length);
        break;
      }

      throw new Error("BAD_DATA");

    }catch(err){
      const status = err.response?.status;

      if(status===429){
        console.error("[429] rate limit → stop retry");
        break;
      }

      console.error("[FETCH ERROR]", err.message);

      if(i<1) await new Promise(r=>setTimeout(r,1000*(i+1)));
    }
  }

  if(!success) LAST_FAILURE_TIME = Date.now();
  return success;
}

// =====================
// init (1회)
// =====================
async function initOnce(){
  if(INIT_DONE) return;
  INIT_DONE = true;

  console.log("[INIT] loading data...");

  const ok = await fetchNewQuizData();

  if(!ok){
    console.log("[FALLBACK] activated");
    MASTER_QUIZ_DATA = FALLBACK_QUIZ;
  }
}

// =====================
// freshness
// =====================
async function ensureDataFreshness(){
  const now=Date.now();
  const stale=(now-LAST_FETCH_TIME)>ONE_HOUR;
  const recentFail=(now-LAST_FAILURE_TIME)<300000;

  if(recentFail) return;
  if(MASTER_QUIZ_DATA.length===0 || stale){
    const ok = await fetchNewQuizData();
    if(!ok) MASTER_QUIZ_DATA = FALLBACK_QUIZ;
  }
}

// =====================
// routes
// =====================
app.get('/',(req,res)=>{
  res.sendFile(path.join(__dirname,'index.html'));
});

app.get('/api/quiz', async (req,res)=>{
  try{
    await initOnce();
    await ensureDataFreshness();

    const quiz = getQuiz();

    res.json(sanitize(quiz));

  }catch(err){
    console.error(err);
    res.json(sanitize(FALLBACK_QUIZ));
  }
});

app.get('/api/answer-key',(req,res)=>{
  try{
    const quiz = getQuiz();
    const key={};

    quiz.forEach(q=>{
      key[q.id]=q.correctAnswerIndex;
    });

    res.json(key);

  }catch{
    res.json({});
  }
});

module.exports = app;
