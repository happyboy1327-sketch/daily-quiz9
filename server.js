const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

let MASTER_QUIZ_DATA = [];
let usedTopics = [];
const allTopics = ["문화예술", "환경", "과학", "역사", "디지털 리터러시", "인권 리터러시", "한글 맞춤법", "코딩", "안전 및 건강상식", "경제", "지리", "정치", "심리학"];

// 1. 검증 및 수정 로직
function validateAndFixQuiz(quiz) {
    // 필수 필드 체크
    if (!quiz.question || !Array.isArray(quiz.choices) || typeof quiz.correctAnswerIndex !== 'number' || !quiz.explanation) return null;
    
    // 해설 기반 정답 인덱스 재보정 (해설에 "정답은 [보기텍스트]입니다." 형태가 있는지 확인)
    const match = quiz.explanation.match(/정답은\s*([^.]+)입니다/);
    if (match) {
        const correctText = match[1].trim();
        const foundIndex = quiz.choices.findIndex(c => c.trim() === correctText);
        if (foundIndex !== -1) quiz.correctAnswerIndex = foundIndex;
    }
    
    // 범위 체크
    if (quiz.correctAnswerIndex < 0 || quiz.correctAnswerIndex >= quiz.choices.length) return null;
    
    return quiz;
}

// 2. 퀴즈 생성
async function fetchAndSetQuizData() {
    if (usedTopics.length >= allTopics.length) usedTopics = [];
    const batch = allTopics.filter(t => !usedTopics.includes(t)).slice(0, 5);
    usedTopics.push(...batch);

    try {
        const prompt = {
            contents: [{ role: "user", parts: [{ text: `분야: ${batch.join(", ")}. 각 분야 1문제씩 총 5문제. JSON 배열 반환. 필수 규칙: explanation은 "정답은 [정답보기텍스트]입니다. [이유...]" 형식으로 시작하고, 모든 오답 보기에 대한 설명 포함할 것.` }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.7 }
        };

        const response = await axios.post(GEMINI_API_URL, prompt, { timeout: 30000 });
        const rawData = JSON.parse(response.data.candidates[0].content.parts[0].text.replace(/```json|```/g, ''));
        
        // 검증 필터링
        const validData = rawData.map(validateAndFixQuiz).filter(q => q !== null);
        
        if (validData.length >= 3) {
            MASTER_QUIZ_DATA = validData.map((q, i) => ({ ...q, id: i + 1 }));
            return true;
        }
        return false;
    } catch (e) {
        console.error("데이터 로딩/검증 에러:", e.message);
        return false;
    }
}

// 3. API 엔드포인트
app.get('/api/quiz', async (req, res) => {
    if (MASTER_QUIZ_DATA.length === 0) {
        const success = await fetchAndSetQuizData();
        if (!success) return res.status(503).json({ message: "데이터 생성 중... 잠시 후 다시 시도하세요." });
    }
    // 정답/해설 제외 전송
    res.json(MASTER_QUIZ_DATA.map(({ correctAnswerIndex, explanation, ...rest }) => rest));
});

app.get('/api/answer-key', (req, res) => {
    res.json(MASTER_QUIZ_DATA.reduce((acc, q) => ({ ...acc, [q.id]: q.correctAnswerIndex }), {}));
});

app.post('/api/reset', (req, res) => {
    MASTER_QUIZ_DATA = [];
    usedTopics = [];
    res.json({ message: "Reset complete" });
});

module.exports = app;
