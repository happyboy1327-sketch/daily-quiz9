// server.js (Vercel 배포 및 1시간 갱신 로직 적용)
const express = require('express');
const cors = require('cors');
const seedrandom = require('seedrandom'); 
const axios = require('axios'); 
const path = require('path');
const app = express();

// 💡 환경 변수에서 API 키를 안전하게 불러옵니다. (Vercel 대시보드에서 설정된 키 사용)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const ONE_HOUR = 3600000; // 1시간 (밀리초)

// 💡 데이터 및 갱신 시간 저장 공간
let MASTER_QUIZ_DATA = [];
let LAST_FETCH_TIME = 0; // 마지막 데이터 로드 시간 (타임스탬프)

// ==========================================================
// 퀴즈 생성 프롬프트 및 설정
// ==========================================================
// 1. 전체 분야 리스트 및 상태 관리 변수
const allTopics = [
  "문화예술", "환경", "과학", "역사", "디지털 리터러시", "인권 리터러시", "한글 맞춤법", "코딩", "안전 및 건강상식", "경제", "지리", "정치"
];

let usedTopics = []; // 사용된 분야 기록용

function getNextPrompt() {
    // 2. 만약 모든 분야를 다 썼다면 초기화
    if (usedTopics.length >= allTopics.length) {
        usedTopics = [];
    }

    // 3. 이번에 사용할 5개 분야 선정
    const remainingTopics = allTopics.filter(t => !usedTopics.includes(t));
    const currentBatch = remainingTopics.slice(0, 5);
    
    // 4. 상태 업데이트
    usedTopics.push(...currentBatch);

    // 5. 프롬프트 생성 (동적 지시사항 포함)
    return {
        contents: [{
            role: "user",
            parts: [{
                text: `
당신은 상식 퀴즈 전문 AI입니다. 아래 5가지 분야에서만 각각 1문제씩, 총 5문제를 생성하세요.
**이번에 출제할 분야:** ${currentBatch.join(", ")}

**필수 규칙:**
1. 위 지정된 5개 분야에서 각 1문제씩 총 5문제를 생성할 것. 순서는 완전히 랜덤이며, 모든 분야 다 쓸 때까진 중복 분야 없다.
2. 보기는 정확히 4개.
3. correctAnswerIndex는 0~3 인덱스 사용.
4. explanation은 반드시 "정답은 [정답보기텍스트]입니다. [이유...]" 형식으로 시작.
5. 모든 오답 보기도 해설에서 왜 틀렸는지 설명.

**JSON 형식 예시:**
[
  {
    "topic": "분야명",
    "question": "질문 내용",
    "choices": ["보기1", "보기2", "보기3", "보기4"],
    "correctAnswerIndex": 0,
    "explanation": "정답은 보기1입니다. [이유]. 보기2는 [이유]. 보기3은 [이유]. 보기4는 [이유]."
  }
]

위 규칙을 준수하여 JSON 배열만 반환하세요.`
            }]
        }],
        generationConfig: { 
            responseMimeType: "application/json",
            temperature: 0.8 
        }
    };
}

// 사용 예시
// const prompt = getNextPrompt();
// const result = await model.generateContent(prompt);

// ==========================================================
// 1. 핵심 유틸리티 함수
// ==========================================================

/**
 * 퀴즈 데이터를 자동으로 수정합니다 (해설 기반으로 정답 인덱스 보정)
 * @param {Object} quiz - 수정할 퀴즈 객체
 * @returns {Object} 수정된 퀴즈 객체
 */
function autoFixQuiz(quiz) {
    // 해설에서 "정답:" 다음 텍스트 추출
    const explanationMatch = quiz.explanation.match(/정답:\s*([^.]+)/);
    if (!explanationMatch) {
        return quiz; // 형식이 맞지 않으면 그대로 반환
    }
    
    const explanationAnswer = explanationMatch[1].trim();
    
    // choices에서 해설의 정답과 일치하는 항목 찾기
    const correctIndex = quiz.choices.findIndex(choice => 
        choice && choice.trim() === explanationAnswer
    );
    
    if (correctIndex !== -1 && correctIndex !== quiz.correctAnswerIndex) {
        console.log(`[AUTO-FIX] 정답 인덱스 자동 수정: ${quiz.correctAnswerIndex} → ${correctIndex} ("${explanationAnswer}")`);
        quiz.correctAnswerIndex = correctIndex;
    }
    
    return quiz;
}

/**
 * 개별 퀴즈 문제가 올바른지 검증합니다.
 * @param {Object} quiz - 검증할 퀴즈 객체
 * @param {number} index - 문제 번호 (로그용)
 * @returns {Object} { isValid: boolean, errors: Array }
 */
function validateSingleQuiz(quiz, index) {
    const errors = [];
    
    // 필수 필드 확인
    if (!quiz.question || !Array.isArray(quiz.choices) || typeof quiz.correctAnswerIndex !== 'number' || !quiz.explanation) {
        errors.push(`필수 필드 누락`);
        return { isValid: false, errors };
    }
    
    // choices 배열 확인 (최소 3개, 최대 5개)
    if (quiz.choices.length < 3 || quiz.choices.length > 5) {
        errors.push(`보기 개수가 올바르지 않음 (현재: ${quiz.choices.length}개)`);
    }
    
    // correctAnswerIndex 범위 확인
    if (quiz.correctAnswerIndex < 0 || quiz.correctAnswerIndex >= quiz.choices.length) {
        errors.push(`correctAnswerIndex(${quiz.correctAnswerIndex})가 범위 초과`);
    }
    
    // 빈 보기가 있는지 확인
    quiz.choices.forEach((choice, choiceIndex) => {
        if (!choice || choice.trim() === '') {
            errors.push(`보기 ${choiceIndex + 1}이 비어있음`);
        }
    });
    
    return {
        isValid: errors.length === 0,
        errors: errors
    };
}

/**
 * 퀴즈 데이터 배열을 검증하고 유효한 문제만 필터링합니다.
 * @param {Array} quizData - 검증할 퀴즈 데이터 배열
 * @returns {Object} { validQuizzes: Array, invalidCount: number, errors: Array }
 */
function filterValidQuizzes(quizData) {
    if (!Array.isArray(quizData) || quizData.length === 0) {
        return { validQuizzes: [], invalidCount: 0, errors: ['퀴즈 데이터가 배열이 아니거나 비어있습니다.'] };
    }
    
    const validQuizzes = [];
    const allErrors = [];
    let invalidCount = 0;
    let fixedCount = 0;
    
    quizData.forEach((quiz, index) => {
        // 💡 먼저 자동 수정 시도
        const fixedQuiz = autoFixQuiz(quiz);
        const validation = validateSingleQuiz(fixedQuiz, index);
        
        if (validation.isValid) {
            validQuizzes.push(fixedQuiz);
            if (fixedQuiz !== quiz) {
                fixedCount++;
            }
        } else {
            invalidCount++;
            allErrors.push(`문제 ${index + 1}: ${validation.errors.join(', ')}`);
        }
    });
    
    return {
        validQuizzes,
        invalidCount,
        fixedCount,
        errors: allErrors
    };
}

function getDailySeed() {
    const today = new Date();
    const year = today.getUTCFullYear();
    const month = String(today.getUTCMonth() + 1).padStart(2, '0');
    const day = String(today.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`; 
}

function shuffleArray(array, seed) {
    const rng = seedrandom(seed); 
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1)); 
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function assignQuizIds(quizData) {
    // 퀴즈 데이터에 고유 ID를 부여합니다.
    return quizData.map((q, index) => ({
        ...q,
        id: index + 1 
    }));
}

function getKRandomQuestions(K, masterData) {
    const seed = getDailySeed();
    const dataCopy = [...masterData]; 
    const count = Math.min(K, dataCopy.length);
    const shuffledCopy = shuffleArray(dataCopy, seed);
    return shuffledCopy.slice(0, count);
}

function sanitizeQuizData(questions) {
    // 클라이언트에게 전송하기 전에 정답 인덱스(correctAnswerIndex)와 해설을 제거합니다.
    return questions.map(q => {
        const { correctAnswerIndex, ...safeQuestion } = q;
        return safeQuestion; 
    });
}

// ==========================================================
// 2. 외부 데이터 로딩 및 갱신 함수
// ==========================================================

async function fetchNewQuizData() {
    console.log(`[DATA] Gemini API를 통해 새로운 퀴즈 데이터 로딩을 시작합니다...`);
    
    const uniqueId = Date.now(); 
    const currentPrompt = getNextPrompt();
    currentPrompt.contents[0].parts[0].text += ` [REQUEST_ID: ${uniqueId}]`;
    const MAX_RETRIES = 2; 
    let success = false;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            console.log(`[DATA] API 호출 재시도 중... (시도 ${attempt + 1}/${MAX_RETRIES + 1})`);
            const delay = Math.pow(2, attempt) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay)); 
        }

        try {
            const response = await axios.post(
                GEMINI_API_URL, 
                currentPrompt,
                { timeout: 90000 } 
            );
            
            const generatedContent = response.data;
            let quizJsonText = '';
            
            if (generatedContent.candidates && generatedContent.candidates.length > 0) {
                quizJsonText = generatedContent.candidates[0].content.parts[0].text;
            } else {
                 throw new Error("Gemini API 응답에서 유효한 후보를 찾을 수 없습니다.");
            }

            const cleanedJsonText = quizJsonText.replace(/```json|```/g, '').trim();
            const newQuizData = JSON.parse(cleanedJsonText);
            
            // 💡 필터링 검증 로직: 유효한 문제만 추출
            const filterResult = filterValidQuizzes(newQuizData);
            
            if (filterResult.fixedCount > 0) {
                console.log(`[AUTO-FIX] ✅ ${filterResult.fixedCount}개의 문제 자동 수정 완료`);
            }
            
            if (filterResult.invalidCount > 0) {
                console.warn(`[VALIDATION WARNING] ${filterResult.invalidCount}개의 문제가 검증 실패로 제외되었습니다:`);
                filterResult.errors.forEach(err => console.warn(`  ⚠️  ${err}`));
            }
            
            // 💡 최소 3개 이상의 유효한 문제가 있어야 성공으로 간주
            if (filterResult.validQuizzes.length >= 3) {
                MASTER_QUIZ_DATA = assignQuizIds(filterResult.validQuizzes); 
                LAST_FETCH_TIME = Date.now(); 
                console.log(`[DATA] ✅ 퀴즈 데이터 갱신 완료. 총 ${MASTER_QUIZ_DATA.length}개의 문제가 로드되었습니다.`);
                if (filterResult.invalidCount === 0) {
                    console.log(`[VALIDATION] ✅ 모든 퀴즈 데이터가 검증을 통과했습니다.`);
                } else {
                    console.log(`[VALIDATION] ⚠️  ${filterResult.validQuizzes.length}개 문제만 사용 (${filterResult.invalidCount}개 제외됨)`);
                }
                success = true;
                break;
            } else {
                throw new Error(`유효한 퀴즈가 ${filterResult.validQuizzes.length}개뿐입니다 (최소 3개 필요). 재시도합니다.`);
            }
            
        } catch (error) {
            lastError = error;
            console.error(`[DATA ERROR] 퀴즈 데이터를 가져오는 데 실패했습니다 (시도 ${attempt + 1}/${MAX_RETRIES + 1}). 오류: ${error.message}`);
            
            if (error.code === 'ECONNABORTED') {
                 console.error("[TIMEOUT] Axios 요청이 90초 타임아웃되었습니다. Vercel 함수 제한 시간 초과 가능성 있음.");
            } else if (error.response) {
                 console.error(`[API FAIL] Gemini API 응답 상태 코드: ${error.response.status}`);
            }
        }
    }
    
    if (!success) {
        console.error('[DATA FAIL] ❌ 모든 시도에서 퀴즈 데이터 로딩에 실패했습니다.');
    }
    
    return success;
}


// ==========================================================
// 3. 미들웨어 및 라우트 설정
// ==========================================================

app.use(cors());
app.use(express.json());

async function ensureDataFreshness() {
    const isDataStale = (Date.now() - LAST_FETCH_TIME) > ONE_HOUR;

    if (MASTER_QUIZ_DATA.length === 0 || isDataStale) {
        console.log(`[CHECK] Data is stale or missing. Attempting refresh...`);
        await fetchNewQuizData();
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/quiz', async (req, res) => {
    await ensureDataFreshness();

    if (MASTER_QUIZ_DATA.length === 0) {
        return res.status(503).json({ 
            errorCode: "DATA_UNAVAILABLE",
            message: "Quiz data is currently loading or unavailable. Please try again shortly. This may indicate a temporary issue with the LLM API or a Vercel timeout." 
        });
    }
    
    const K = 5; 
    
    try {
        const todaysQuestions = getKRandomQuestions(K, MASTER_QUIZ_DATA);
        const sortedQuestions = todaysQuestions.sort((a, b) => a.id - b.id);
        const safePayload = sanitizeQuizData(sortedQuestions);
        
        return res.status(200).json(safePayload);
    } catch (error) {
        console.error("Quiz API Error:", error);
        return res.status(500).json({ 
             errorCode: "SERVER_ERROR", 
             message: "Internal server error occurred during data retrieval." 
          });
    }
});

app.get('/api/answer-key', async (req, res) => {
    await ensureDataFreshness();

    if (MASTER_QUIZ_DATA.length === 0) {
        return res.status(503).json({ error: "Data unavailable" });
    }

    const K = 5;
    
    try {
        const todaysQuestions = getKRandomQuestions(K, MASTER_QUIZ_DATA); 
        const sortedQuestions = todaysQuestions.sort((a, b) => a.id - b.id);

        const answerKey = sortedQuestions.reduce((acc, q) => {
            if (typeof q.id === 'number' && typeof q.correctAnswerIndex === 'number') {
                acc[q.id] = q.correctAnswerIndex;
            }
            return acc;
        }, {});
        
        return res.status(200).json(answerKey);
    } catch (error) {
        console.error("Answer Key API Error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ==========================================================
// 4. Vercel 서버리스 모듈 내보내기 (필수)
// ==========================================================
module.exports = app;
