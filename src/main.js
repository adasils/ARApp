const CONTENT_PATH = '/data/wines.json';
const TARGET_TO_WINE = {
  0: 'wine-demo-001',
};

const ui = {
  welcomeCard: document.getElementById('welcomeCard'),
  contentCard: document.getElementById('contentCard'),
  quizCard: document.getElementById('quizCard'),
  wineTitle: document.getElementById('wineTitle'),
  wineDescription: document.getElementById('wineDescription'),
  wineVideo: document.getElementById('wineVideo'),
  quizButton: document.getElementById('quizButton'),
  quizQuestion: document.getElementById('quizQuestion'),
  quizAnswers: document.getElementById('quizAnswers'),
  quizResult: document.getElementById('quizResult'),
  quizReset: document.getElementById('quizReset'),
};

let wines = [];
let activeWine = null;

async function loadContent() {
  const response = await fetch(CONTENT_PATH);
  if (!response.ok) {
    throw new Error(`Не удалось загрузить ${CONTENT_PATH}`);
  }
  const payload = await response.json();
  wines = payload.wines || [];
}

function getWineByTargetIndex(index) {
  const wineId = TARGET_TO_WINE[index];
  return wines.find((wine) => wine.id === wineId) || null;
}

function showWineContent(wine) {
  activeWine = wine;
  ui.wineTitle.textContent = wine.title;
  ui.wineDescription.textContent = wine.description;

  ui.wineVideo.src = wine.videoUrl;
  ui.wineVideo.poster = wine.posterUrl || '';
  ui.wineVideo.load();

  ui.welcomeCard.classList.add('hidden');
  ui.contentCard.classList.remove('hidden');
  ui.quizCard.classList.add('hidden');
  ui.quizResult.textContent = '';
}

function renderQuiz(question) {
  ui.quizQuestion.textContent = question.question;
  ui.quizAnswers.innerHTML = '';

  question.answers.forEach((answer) => {
    const button = document.createElement('button');
    button.className = 'answer-btn';
    button.textContent = answer.text;
    button.addEventListener('click', () => {
      ui.quizResult.textContent = answer.correct
        ? 'Верно. Отлично чувствуешь стиль этого вина.'
        : 'Не совсем. Попробуй еще раз.';
    });
    ui.quizAnswers.appendChild(button);
  });
}

function attachEvents() {
  const targetEntity = document.getElementById('targetEntity');

  targetEntity.addEventListener('targetFound', () => {
    const indexAttr = targetEntity.getAttribute('mindar-image-target');
    const targetIndex = Number(indexAttr.targetIndex);
    const wine = getWineByTargetIndex(targetIndex);

    if (wine) {
      showWineContent(wine);
    }
  });

  targetEntity.addEventListener('targetLost', () => {
    ui.wineVideo.pause();
  });

  ui.quizButton.addEventListener('click', () => {
    if (!activeWine || !activeWine.quiz || activeWine.quiz.length === 0) {
      return;
    }

    renderQuiz(activeWine.quiz[0]);
    ui.quizCard.classList.remove('hidden');
  });

  ui.quizReset.addEventListener('click', () => {
    if (!activeWine || !activeWine.quiz || activeWine.quiz.length === 0) {
      return;
    }
    ui.quizResult.textContent = '';
    renderQuiz(activeWine.quiz[0]);
  });
}

async function bootstrap() {
  try {
    await loadContent();
    attachEvents();
  } catch (error) {
    ui.welcomeCard.innerHTML = `<h1>Ошибка загрузки</h1><p>${error.message}</p>`;
  }
}

bootstrap();
