import { useEffect, useState } from "react";
import {
  Plus,
  Minus,
  Trash2,
  TriangleAlert,
  Check,
  PencilLine,
  CheckCheck,
} from "lucide-react";
import { api } from "../lib/api";
import type { FileEntry } from "../lib/types";
import { copyText, revealPath } from "../lib/actions";
import { joinPath } from "../lib/format";
import { useRepo } from "../repo/RepoContext";
import { confirmAction, openMenu } from "../store";
import { FileRow } from "./FileList";
import { t } from "../lib/i18n";

function draftKey(path: string) {
  return `mobyd.draft.${path}`;
}

export function WipPanel() {
  const ctx = useRepo();
  const st = ctx.data?.status;
  const [summary, setSummary] = useState("");
  const [desc, setDesc] = useState("");
  const [amend, setAmend] = useState(false);

  useEffect(() => {
    try {
      const d = JSON.parse(localStorage.getItem(draftKey(ctx.path)) ?? "null");
      if (d) {
        setSummary(d.summary ?? "");
        setDesc(d.desc ?? "");
      }
    } catch {
      /* ignore */
    }
  }, [ctx.path]);

  useEffect(() => {
    try {
      localStorage.setItem(
        draftKey(ctx.path),
        JSON.stringify({ summary, desc }),
      );
    } catch {
      /* ignore */
    }
  }, [ctx.path, summary, desc]);

  if (!st) return null;
  const unstaged = st.unstaged;
  const staged = st.staged;
  const conflicted = st.conflicted;
  const op = ctx.data?.state.operation;

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on && !summary.trim()) {
      const msg = await api.lastMessage(ctx.path).catch(() => "");
      const [first, ...rest] = msg.split("\n");
      setSummary(first ?? "");
      setDesc(rest.join("\n").trim());
    }
  };

  const discard = async (files: FileEntry[]) => {
    const ok = await confirmAction(
      t("변경 버리기"),
      files.length === 1
        ? t("{path} 의 변경을 버립니다. 되돌릴 수 없습니다.", {
            path: files[0].path,
          })
        : t("{length}개 파일의 변경을 버립니다. 되돌릴 수 없습니다.", {
            length: files.length,
          }),
      t("버리기"),
      true,
    );
    if (!ok) return;
    await ctx.run(t("변경 버리기"), () =>
      api.discard(
        ctx.path,
        files.filter((f) => f.status !== "?").map((f) => f.path),
        files.filter((f) => f.status === "?").map((f) => f.path),
      ),
    );
    if (ctx.diff && files.some((f) => f.path === ctx.diff?.path))
      ctx.openDiff(null);
  };

  const fileMenu =
    (f: FileEntry, kind: "unstaged" | "staged") => (e: React.MouseEvent) =>
      openMenu(e, [
        kind === "unstaged"
          ? {
              label: t("스테이징"),
              icon: <Plus size={14} />,
              onClick: () =>
                ctx.run(t("스테이징"), () => api.stage(ctx.path, [f.path]), {
                  quiet: true,
                }),
            }
          : {
              label: t("스테이징 해제"),
              icon: <Minus size={14} />,
              onClick: () =>
                ctx.run(t("해제"), () => api.unstage(ctx.path, [f.path]), {
                  quiet: true,
                }),
            },
        ...(kind === "unstaged"
          ? [
              {
                label: t("변경 버리기…"),
                icon: <Trash2 size={14} />,
                danger: true,
                onClick: () => discard([f]),
              },
            ]
          : []),
        { separator: true },
        ...(f.status !== "?"
          ? [
              {
                label: "Blame",
                onClick: () => ctx.openBlame({ path: f.path }),
              },
              {
                label: t("파일 히스토리"),
                onClick: () => ctx.showHistory(f.path),
              },
            ]
          : []),
        { label: t("경로 복사"), onClick: () => copyText(f.path) },
        {
          label: t("Finder에서 보기"),
          onClick: () => revealPath(joinPath(ctx.info.root, f.path)),
        },
      ]);

  const prepared = ctx.data?.state.message ?? "";
  const effectiveSummary =
    summary.trim() || (op ? prepared.split("\n")[0] : "");
  const canCommit =
    effectiveSummary.length > 0 &&
    conflicted.length === 0 &&
    (staged.length > 0 || amend || op === "merge");
  const doCommit = async (stageAll = false) => {
    const body =
      desc.trim() ||
      (!summary.trim() && op
        ? prepared.split("\n").slice(1).join("\n").trim()
        : "");
    const message = body ? `${effectiveSummary}\n\n${body}` : effectiveSummary;
    const r = await ctx.run(
      amend ? t("커밋 수정") : t("커밋"),
      async () => {
        if (stageAll) await api.stage(ctx.path, []);
        return api.commit(ctx.path, message, amend);
      },
      { success: amend ? t("마지막 커밋을 수정했습니다") : t("커밋했습니다") },
    );
    if (r !== undefined) {
      setSummary("");
      setDesc("");
      setAmend(false);
      ctx.openDiff(null);
      ctx.select(null);
    }
  };

  const clean =
    unstaged.length === 0 &&
    staged.length === 0 &&
    conflicted.length === 0 &&
    !op;
  const active = (path: string, kind: string) =>
    ctx.diff?.path === path && ctx.diff.kind === kind;

  return (
    <div className="panel wip">
      <div className="panel-head">
        <div className="panel-kicker">
          <PencilLine size={13} /> {t("작업 중인 변경 ·")}{" "}
          {st.branch ?? t("분리된 HEAD")}
        </div>
      </div>

      {clean && (
        <div className="wip-clean">
          <CheckCheck size={22} />
          <strong>{t("작업 트리가 깨끗합니다")}</strong>
          <span>{t("파일을 고치면 여기에 변경 내용이 나타납니다.")}</span>
        </div>
      )}

      {conflicted.length > 0 && (
        <div className="stage-box conflict">
          <div className="stage-head">
            <TriangleAlert size={13} /> {t("충돌")} <b>{conflicted.length}</b>
          </div>
          <p className="conflict-help">{t("파일마다 어느 쪽을 쓸지 고르거나, 직접 고친 뒤 ✓를 눌러 해결로 표시하세요.")}</p>
          <div className="files">
            {conflicted.map((f) => (
              <FileRow
                key={f.path}
                f={f}
                active={active(f.path, "unstaged")}
                onClick={() => ctx.openDiff({ kind: "unstaged", path: f.path })}
                actions={
                  <>
                    <button
                      className="btn xs"
                      title={t("현재 브랜치 쪽 사용")}
                      onClick={() =>
                        ctx.run(
                          t("충돌 해결"),
                          () => api.resolveConflict(ctx.path, f.path, "ours"),
                          { quiet: true },
                        )
                      }
                    >
                      {t("내 변경")}
                    </button>
                    <button
                      className="btn xs"
                      title={t("들어오는 쪽 사용")}
                      onClick={() =>
                        ctx.run(
                          t("충돌 해결"),
                          () => api.resolveConflict(ctx.path, f.path, "theirs"),
                          { quiet: true },
                        )
                      }
                    >
                      {t("상대 변경")}
                    </button>
                    <button
                      className="icon-btn"
                      title={t("직접 고친 뒤 해결 완료로 표시")}
                      onClick={() =>
                        ctx.run(
                          t("해결 표시"),
                          () => api.stage(ctx.path, [f.path]),
                          { quiet: true },
                        )
                      }
                    >
                      <Check size={13} />
                    </button>
                  </>
                }
              />
            ))}
          </div>
        </div>
      )}

      {!clean && (
        <div className="stage-box">
          <div className="stage-head">
            {t("스테이징 안 됨")} <b>{unstaged.length}</b>
            <span className="flex1" />
            {unstaged.length > 0 && (
              <>
                <button
                  className="btn xs ghost danger-text"
                  onClick={() => discard(unstaged)}
                >
                  {t("모두 버리기")}
                </button>
                <button
                  className="btn xs"
                  onClick={() =>
                    ctx.run(t("스테이징"), () => api.stage(ctx.path, []), {
                      quiet: true,
                    })
                  }
                >
                  <CheckCheck size={12} /> {t("모두 스테이징")}
                </button>
              </>
            )}
          </div>
          <div className="files">
            {unstaged.length === 0 && (
              <p className="sb-empty">{t("변경 없음")}</p>
            )}
            {unstaged.map((f) => (
              <FileRow
                key={"u" + f.path}
                f={f}
                active={active(
                  f.path,
                  f.status === "?" ? "untracked" : "unstaged",
                )}
                onClick={() =>
                  ctx.openDiff({
                    kind: f.status === "?" ? "untracked" : "unstaged",
                    path: f.path,
                  })
                }
                onDoubleClick={() =>
                  ctx.run(t("스테이징"), () => api.stage(ctx.path, [f.path]), {
                    quiet: true,
                  })
                }
                onContextMenu={fileMenu(f, "unstaged")}
                actions={
                  <>
                    <button
                      className="icon-btn"
                      title={t("변경 버리기")}
                      onClick={() => discard([f])}
                    >
                      <Trash2 size={13} />
                    </button>
                    <button
                      className="icon-btn stage"
                      title={t("스테이징")}
                      onClick={() =>
                        ctx.run(
                          t("스테이징"),
                          () => api.stage(ctx.path, [f.path]),
                          { quiet: true },
                        )
                      }
                    >
                      <Plus size={14} />
                    </button>
                  </>
                }
              />
            ))}
          </div>
        </div>
      )}

      {!clean && (
        <div className="stage-box">
          <div className="stage-head">
            {t("스테이징됨")} <b>{staged.length}</b>
            <span className="flex1" />
            {staged.length > 0 && (
              <button
                className="btn xs"
                onClick={() =>
                  ctx.run(t("스테이징 해제"), () => api.unstage(ctx.path, []), {
                    quiet: true,
                  })
                }
              >
                {t("모두 해제")}
              </button>
            )}
          </div>
          <div className="files">
            {staged.length === 0 && (
              <p className="sb-empty">{t("스테이징된 파일이 없습니다")}</p>
            )}
            {staged.map((f) => (
              <FileRow
                key={"s" + f.path}
                f={f}
                active={active(f.path, "staged")}
                onClick={() =>
                  ctx.openDiff({
                    kind: "staged",
                    path: f.path,
                    origPath: f.origPath,
                  })
                }
                onDoubleClick={() =>
                  ctx.run(t("해제"), () => api.unstage(ctx.path, [f.path]), {
                    quiet: true,
                  })
                }
                onContextMenu={fileMenu(f, "staged")}
                actions={
                  <button
                    className="icon-btn unstage"
                    title={t("스테이징 해제")}
                    onClick={() =>
                      ctx.run(
                        t("해제"),
                        () => api.unstage(ctx.path, [f.path]),
                        { quiet: true },
                      )
                    }
                  >
                    <Minus size={14} />
                  </button>
                }
              />
            ))}
          </div>
        </div>
      )}

      <form
        className="commit-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (canCommit) doCommit();
        }}
        onKeyDown={(e) => {
          // ⌘↵ commits from the summary and from the description
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) {
            e.preventDefault();
            doCommit();
          }
        }}
      >
        <div className="summary-row">
          <input
            placeholder={
              op && prepared ? prepared.split("\n")[0] : t("커밋 요약 (필수)")
            }
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
          <span className={"count" + (summary.length > 72 ? " over" : "")}>
            {summary.length}
          </span>
        </div>
        <textarea
          placeholder={t("자세한 설명 (선택)")}
          rows={4}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={amend}
            onChange={(e) => toggleAmend(e.target.checked)}
          />
          <span>{t("마지막 커밋 수정 (amend)")}</span>
        </label>
        <button
          type="submit"
          className="btn primary block"
          disabled={!canCommit}
          title={canCommit ? t("커밋 (⌘↵)") : undefined}
        >
          {amend
            ? t("마지막 커밋 수정")
            : staged.length
              ? t("파일 {length}개 커밋", { length: staged.length })
              : t("커밋")}
        </button>
        <p className="commit-hint">
          {canCommit
            ? t("⌘↵를 눌러도 커밋됩니다.")
            : clean && !amend
              ? t("커밋할 변경이 없습니다.")
              : conflicted.length > 0
                ? t("충돌을 먼저 해결하세요.")
                : !effectiveSummary
                  ? t("커밋 요약을 입력하면 커밋할 수 있습니다.")
                  : t(
                      "커밋할 파일을 스테이징하세요. 파일을 더블클릭하면 스테이징됩니다.",
                    )}
        </p>
        {!amend && staged.length === 0 && unstaged.length > 0 && conflicted.length === 0 && (
          <button
            type="button"
            className="btn block"
            disabled={!effectiveSummary}
            onClick={() => doCommit(true)}
          >
            {t("모든 변경 스테이징 후 커밋")}
          </button>
        )}
      </form>
    </div>
  );
}
