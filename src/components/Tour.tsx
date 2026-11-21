// Step-by-step tour of the basics: a spotlight on one part of the window and a
// card next to it. Starts by itself the first time a repository opens, and
// again from the command palette or the "?" button in the top bar.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useUi } from "../store";
import { t } from "../lib/i18n";

const DONE_KEY = "mobyd.tour.v1";
const PAD = 6;
const GAP = 12;
const CARD_W = 340;

interface Step {
  /** CSS selectors; the spotlight covers all of them. None: a centred card. */
  target?: string[];
  /** Look inside the active repository tab (not in hidden tabs). */
  inRepo?: boolean;
  title: string;
  body: string;
  /** Runs before the step is shown (scroll something into view). */
  prepare?: () => void;
}

function steps(): Step[] {
  return [
    {
      title: t("MobyD 둘러보기"),
      body: t("기본 기능을 한 단계씩 짚어 드립니다. → 키나 [다음]으로 넘어가고, Esc로 언제든 닫을 수 있습니다. 나중에 상단의 ? 버튼이나 ⌘K에서 다시 볼 수 있습니다."),
    },
    {
      target: [".tabs"],
      title: t("저장소는 탭으로 열립니다"),
      body: t("+ 버튼으로 이 PC의 폴더를 열거나, 복제하거나, SSH로 다른 PC에 있는 저장소를 엽니다. ⌘1–9로 탭을 오갑니다."),
    },
    {
      target: [".branch-pill"],
      inRepo: true,
      title: t("지금 체크아웃된 브랜치"),
      body: t("작업 폴더가 지금 어느 브랜치에 있는지 보여 줍니다. ↑는 아직 올리지 않은 커밋, ↓는 아직 받지 않은 커밋 수입니다. 누르면 다른 브랜치로 전환합니다."),
    },
    {
      target: [".g-row.is-head"],
      inRepo: true,
      title: t("이 PC가 체크아웃한 커밋"),
      body: t("고리가 둘린 점과 노트북 아이콘(SSH 저장소는 서버 아이콘)이 작업 폴더의 현재 위치(HEAD)입니다. 아이콘에 마우스를 올리면 자세히 나옵니다. 주황색이면 브랜치 없이 체크아웃한 상태입니다. 그 위의 점선 원은 아직 커밋하지 않은 변경이고, 점선 갈래 아이콘은 다른 워크트리가 체크아웃한 커밋입니다. 스크롤해서 멀어지면 과녁 버튼으로 돌아옵니다."),
      prepare: () => window.dispatchEvent(new Event("mobyd-reveal-head")),
    },
    {
      target: [".g-scroll"],
      inRepo: true,
      title: t("커밋 그래프"),
      body: t("커밋을 누르면 오른쪽에 바뀐 파일이 나옵니다. 오른쪽 클릭하면 체크아웃·브랜치 만들기·체리픽·되돌리기·리셋·인터랙티브 리베이스 메뉴가 있습니다. 브랜치 이름표를 더블클릭하면 그 브랜치로 전환합니다. ↑↓ 또는 j/k로 이동합니다."),
    },
    {
      target: [".detail"],
      inRepo: true,
      title: t("변경 확인 · 스테이징 · 커밋"),
      body: t("맨 위의 [작업 중인 변경]을 고르면 여기서 파일을 스테이징합니다. 파일을 누르면 diff가 열리고, 헝크나 줄 단위로도 골라 담을 수 있습니다. 요약을 적고 커밋하세요."),
    },
    {
      target: [".toolbar [data-tour=sync]"],
      inRepo: true,
      title: t("받기와 올리기"),
      body: t("Pull은 원격의 새 커밋을 받고, Push는 내 커밋을 올립니다. 옆의 ▾에 fetch만 하기, rebase로 받기, 강제 푸시 같은 옵션이 있습니다."),
    },
    {
      target: [".toolbar [data-tour=undo]"],
      inRepo: true,
      title: t("실수해도 되돌릴 수 있습니다"),
      body: t("커밋·체크아웃·병합·리베이스·리셋·브랜치 삭제를 ⌘Z로 되돌리고 ⇧⌘Z로 다시 실행합니다."),
    },
    {
      target: [".toolbar [data-tour=tools]"],
      inRepo: true,
      title: t("자주 쓰는 작업"),
      body: t("새 브랜치, 변경 잠시 보관(Stash)과 꺼내기(Pop), 워크트리 추가, 풀 리퀘스트 만들기, 이 폴더에서 터미널 열기입니다."),
    },
    {
      target: [".sidebar"],
      inRepo: true,
      title: t("브랜치 · 원격 · 워크트리"),
      body: t("로컬·원격 브랜치, 워크트리, Stash, 풀 리퀘스트, 태그가 모여 있습니다. 더블클릭하면 체크아웃하고, 오른쪽 클릭하면 병합·리베이스·이름 바꾸기·삭제 메뉴가 나옵니다."),
    },
    {
      target: [".toolbar .search"],
      inRepo: true,
      title: t("커밋 찾기"),
      body: t("메시지·작성자·SHA로 커밋을 찾습니다. Enter로 다음, ⇧Enter로 이전 결과로 갑니다."),
    },
    {
      target: [".palette-btn"],
      title: t("모든 명령은 ⌘K에"),
      body: t("이름 몇 글자만 쳐서 어떤 작업이든 실행하고, 브랜치를 전환하고, 저장소를 엽니다. 이 둘러보기도 여기서 다시 시작할 수 있습니다."),
    },
  ];
}

export function startTour() {
  window.dispatchEvent(new Event("mobyd-tour"));
}

function markDone() {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* ignore */
  }
}

function seen() {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return true;
  }
}

function findTargets(step: Step): HTMLElement[] {
  if (!step.target) return [];
  const scope: ParentNode = step.inRepo ? document.querySelector(".repo-host:not([hidden])") ?? document : document;
  return step.target.flatMap((sel) => [...scope.querySelectorAll<HTMLElement>(sel)]).filter((el) => el.getClientRects().length > 0);
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function unionRect(els: HTMLElement[]): Box | null {
  if (!els.length) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const el of els) {
    const x = el.getBoundingClientRect();
    l = Math.min(l, x.left);
    t = Math.min(t, x.top);
    r = Math.max(r, x.right);
    b = Math.max(b, x.bottom);
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  l = Math.max(l - PAD, 4);
  t = Math.max(t - PAD, 4);
  r = Math.min(r + PAD, vw - 4);
  b = Math.min(b + PAD, vh - 4);
  return { left: l, top: t, width: r - l, height: b - t };
}

/** Where the card goes: below, above, right or left of the spotlight, kept on screen. */
export function placeCard(box: Box | null, card: { width: number; height: number }, vw: number, vh: number): { left: number; top: number } {
  if (!box) return { left: (vw - card.width) / 2, top: Math.max(16, (vh - card.height) / 2) };
  const clampX = (x: number) => Math.min(Math.max(12, x), vw - card.width - 12);
  const clampY = (y: number) => Math.min(Math.max(12, y), vh - card.height - 12);
  const below = box.top + box.height + GAP;
  if (below + card.height <= vh - 12) return { left: clampX(box.left), top: below };
  const above = box.top - GAP - card.height;
  if (above >= 12) return { left: clampX(box.left), top: above };
  const right = box.left + box.width + GAP;
  if (right + card.width <= vw - 12) return { left: right, top: clampY(box.top) };
  const left = box.left - GAP - card.width;
  if (left >= 12) return { left, top: clampY(box.top) };
  // The target fills the window: lay the card over its lower part.
  return { left: clampX(box.left + (box.width - card.width) / 2), top: clampY(box.top + box.height - card.height - 24) };
}

export function Tour() {
  const [index, setIndex] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const list = useRef<Step[]>([]);
  const dir = useRef<1 | -1>(1);
  const active = useUi((s) => s.active);
  const modal = useUi((s) => s.modal);

  const open = useCallback(() => {
    list.current = steps();
    dir.current = 1;
    setIndex(0);
  }, []);
  const close = useCallback(() => {
    markDone();
    setIndex(null);
  }, []);
  const setBoxIfMoved = useCallback((b: Box | null) => {
    setBox((p) => (p && b && p.left === b.left && p.top === b.top && p.width === b.width && p.height === b.height ? p : b));
  }, []);
  const go = useCallback((d: 1 | -1) => {
    dir.current = d;
    setIndex((i) => {
      if (i === null) return i;
      const n = i + d;
      if (n < 0) return 0;
      if (n >= list.current.length) {
        markDone();
        return null;
      }
      return n;
    });
  }, []);

  useEffect(() => {
    window.addEventListener("mobyd-tour", open);
    return () => window.removeEventListener("mobyd-tour", open);
  }, [open]);

  // First time a repository is on screen: start by itself.
  useEffect(() => {
    if (!active || modal || index !== null || seen()) return;
    const id = window.setTimeout(() => {
      if (document.querySelector(".repo-host:not([hidden]) .g-row") && !seen()) open();
    }, 900);
    return () => window.clearTimeout(id);
  }, [active, modal, index, open]);

  // Show the step: skip it when its target is not on screen (no WIP, no tabs…).
  useLayoutEffect(() => {
    if (index === null) return;
    const step = list.current[index];
    step.prepare?.();
    const measure = () => {
      const els = findTargets(step);
      if (step.target && !els.length) {
        go(dir.current);
        return;
      }
      setBoxIfMoved(unionRect(els));
    };
    // Let a prepare() scroll settle before measuring.
    const first = window.setTimeout(measure, 60);
    const follow = window.setInterval(() => {
      const els = findTargets(step);
      if (els.length || !step.target) setBoxIfMoved(unionRect(els));
    }, 250);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(follow);
      window.removeEventListener("resize", measure);
    };
  }, [index, go, setBoxIfMoved]);

  useLayoutEffect(() => {
    if (index === null || !card.current) return;
    const r = card.current.getBoundingClientRect();
    const next = placeCard(box, { width: r.width, height: r.height }, window.innerWidth, window.innerHeight);
    setPos((p) => (p && Math.abs(p.left - next.left) < 1 && Math.abs(p.top - next.top) < 1 ? p : next));
  }, [box, index]);

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" || e.key === "Enter") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, go, close]);

  if (index === null) return null;
  const step = list.current[index];
  const total = list.current.length;
  const last = index === total - 1;
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label={step.title}>
      <div className="tour-block" onMouseDown={(e) => e.preventDefault()} />
      {box ? (
        <div className="tour-spot" style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div
        ref={card}
        className="tour-card"
        style={{ width: CARD_W, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      >
        <button className="tour-x" onClick={close} aria-label={t("둘러보기 닫기")} title={t("둘러보기 닫기 (Esc)")}>
          <X size={14} />
        </button>
        <div className="tour-step">
          {index + 1} / {total}
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-foot">
          <div className="tour-dots">
            {list.current.map((_, i) => (
              <span key={i} className={i === index ? "on" : ""} />
            ))}
          </div>
          {index === 0 ? (
            <button className="btn sm" onClick={close}>
              {t("건너뛰기")}
            </button>
          ) : (
            <button className="btn sm" onClick={() => go(-1)}>
              <ChevronLeft size={13} />
              {t("이전")}
            </button>
          )}
          <button className="btn sm primary" onClick={() => go(1)} autoFocus>
            {last ? t("마치기") : index === 0 ? t("시작하기") : t("다음")}
            {!last && <ChevronRight size={13} />}
          </button>
        </div>
      </div>
    </div>
  );
}
