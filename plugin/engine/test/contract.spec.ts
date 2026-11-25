import { expect, it } from "vitest";
import type * as Panel from "../../types";
import type { Audience, Ask, Decision, Doctor, EvalCase, EvalRun, Handle, Placement, Policy, PrState, RefsFile, Reply, ReplyMode, Reviews, ScenarioRule, SearchHit, SourceHealth, Thing, UndoEntry } from "../src/shared/types";

// 面板的类型合同（plugin/types/index.d.ts）不能 import，照抄了引擎的数据类型。这里在类型上检查：
// 引擎写出来的每样东西，都能当成面板那份读。不成立时 tsc --noEmit 报错（这个文件本身运行时什么都不做）。
type Fits<A extends B, B> = A;

export type Checks = [
  Fits<Reply, Panel.ReplyRow>,
  Fits<Thing, Panel.ThingRow>,
  Fits<Ask, Panel.AskRow>,
  Fits<Decision, Panel.DecisionRow>,
  Fits<Decision["verdict"], Panel.Verdict>,
  Fits<Handle, Panel.Handle>,
  Fits<ReplyMode, Panel.ReplyMode>,
  Fits<Audience, Panel.Audience>,
  Fits<Placement, Panel.Placement>,
  Fits<ScenarioRule, Panel.Rule>,
  Fits<Policy, Panel.PolicyFile>,
  Fits<Reviews, Panel.Reviews>,
  Fits<SourceHealth, Panel.Health>,
  Fits<EvalCase, Panel.EvalCaseRow>,
  Fits<EvalRun, Panel.EvalRunRow>,
  Fits<Doctor, Panel.Doctor>,
  Fits<UndoEntry, Panel.UndoRow>,
  Fits<SearchHit, Panel.SearchHit>,
  Fits<PrState, Panel.PrRow>,
  Fits<RefsFile, Panel.RefsFile>,
  // 反过来：面板认得的判断、做法，引擎都认得（面板会把它们写回去）。
  Fits<Panel.Verdict, Decision["verdict"]>,
  Fits<Panel.Handle, Handle>,
  Fits<Panel.ReplyMode, ReplyMode>,
  Fits<Panel.Placement, Placement>,
];

it("面板的类型合同和引擎的数据类型对得上（见 tsc --noEmit）", () => {
  expect(true).toBe(true);
});
