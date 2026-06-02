
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

// 1. 방어적 검증 함수
function validateAndFixQuiz(quiz) {
    try {
        if (!quiz || !quiz.question || !Array.isArray(quiz.choices) || typeof quiz.correctAnswerIndex !== 'number' || !quiz.explanation) return null;
        
        const match = quiz.explanation.match(/정답은\s*([^.]+)입니다/);
        if (match && match[1]) {
            const correctText = match[1].trim();
            const foundIndex = quiz.choices.findIndex(c => c && c.trim() === correctText);
            if (foundIndex !== -1) quiz.correctAnswerIndex = foundIndex;
        }
        
        if (quiz.correctAnswerIndex < 0 || quiz.correctAnswerIndex >= quiz.choices.length) return null;
        return quiz;
    } catch (e) { return null; }
}

// 2. 데이터 생성 함수 (에러 핸들링 최적화)
async function fetchAndSetQuizData() {
    if (usedTopics.length >= allTopics.length) usedTopics = [];
    const batch = allTopics.filter(t => !usedTopics.includes(t)).slice(0, 5);
    usedTopics.push(...batch);

    try {
        const response = await axios.post(GEMINI_API_URL, {
            contents: [{ role: "user", parts: [{ text: `분야: ${batch.join(", ")}. 각 분야 1문제씩 총 5문제. JSON 배열 반환. 필수 규칙: explanation은 "정답은 [정답보기텍스트]입니다. [이유...]" 형식으로 시작할 것.` }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.7 }
        }, { timeout: 30000 });

        // 데이터가 없는 경우를 대비
        const text = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("API 응답 데이터 부재");
        
        const rawData = JSON.parse(text.replace(/```json|```/g, ''));
        if (!Array.isArray(rawData)) throw new Error("배열 형식 아님");

        const validData = rawData.map(validateAndFixQuiz).filter(q => q !== null);
        
        if (validData.length > 0) {
            MASTER_QUIZ_DATA = validData.map((q, i) => ({ ...q, id: i + 1 }));
            return true;
        }
        return false;
    } catch (e) {
        console.error("데이터 생성 실패:", e.message);
        return false;
    }
}

// 3. 엔드포인트
app.get('/api/quiz', async (req, res) => {
    if (MASTER_QUIZ_DATA.length === 0) {
        const success = await fetchAndSetQuizData();
        if (!success) return res.status(503).json({ message: "데이터 생성 실패. 잠시 후 버튼을 다시 눌러주세요." });
    }
    res.json(MASTER_QUIZ_DATA.map(({ correctAnswerIndex, explanation, ...rest }) => rest));
});

app.post('/api/reset', (req, res) => {
    MASTER_QUIZ_DATA = [];
    usedTopics = [];
    res.json({ message: "Reset complete" });
});

module.exports = app;
