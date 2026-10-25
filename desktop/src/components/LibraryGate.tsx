import { useEffect, useState } from "react";
import api from "../api";
import type { LibraryBrief, LibraryOpenResult } from "../../shared/types";

/**
 * 还没有书库时铺这一页。
 * 一个书库就是一个文件夹：书、漫画、书评、封面、备份全在里面，
 * 重装软件或换一台机器，把这个文件夹搬过去就行。
 */
export default function LibraryGate({ onOpened }: { onOpened: () => void }) {
  const [recent, setRecent] = useState<LibraryBrief[]>([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const loadRecent = () => {
    api.libraryRecent().then(setRecent);
  };
  useEffect(loadRecent, []);

  const done = (r: LibraryOpenResult | null) => {
    setBusy("");
    if (r?.ok) {
      onOpened();
      return;
    }
    setMsg(r?.msg || "没有打开");
    loadRecent();
  };

  const choose = async () => {
    setBusy("正在打开…");
    setMsg("");
    done(await api.chooseLibrary());
  };

  const useDefault = async () => {
    setBusy("正在新建…");
    setMsg("");
    done(await api.defaultLibrary());
  };

  const open = async (root: string) => {
    setBusy("正在打开…");
    setMsg("");
    done(await api.openLibrary(root));
  };

  return (
    <div className="gate">
      <div className="gate-in">
        <div className="gate-brand">藏书库</div>
        <div className="gate-lead">
          选一个文件夹当书库。书、漫画、书评、封面、备份全部装进这个文件夹，
          重装软件不会动它，换机器把它拷过去就能接着用。
        </div>

        <div className="gate-acts">
          <button className="mini gate-main" onClick={choose} disabled={!!busy}>
            选择书库文件夹…
          </button>
          <button className="mini xs" onClick={useDefault} disabled={!!busy}>
            在文档里新建「我的书库」
          </button>
        </div>

        <div className="gate-hint">
          {busy || msg || "选一个空文件夹就是新建，选已有书库的文件夹就是打开。"}
        </div>

        {recent.length ? (
          <div className="gate-recent">
            <div className="gr-t">最近打开</div>
            {recent.map((r) => (
              <button key={r.root} className="gr-row" onClick={() => open(r.root)} title={"打开 " + r.root}>
                <span className="gr-name">{r.root.split(/[\\/]/).pop() || r.root}</span>
                <span className="gr-path">{r.root}</span>
                <span className="gr-n">
                  {r.reviews} 篇书评 · {r.covers} 张封面
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="gate-foot">
          书库里的 reviews 文件夹存着全部书评的 markdown，改那边的 md 软件里会跟着变，反过来也一样。
        </div>
      </div>
    </div>
  );
}
