import type {
  CarryOverPlan,
  ImportMoveList,
  ImportPathList,
  ImportSkippedList,
  ObsidianImportPreview,
  ObsidianUpdateReport,
} from "@ddl/core";
import { formatBytes, pluralize } from "@ddl/core";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import {
  attachmentKinds,
  dailyNotesText,
  dailyPlaceText,
  editorSettingsText,
  joinWords,
  SKIP_REASON,
  SUPPORT,
} from "./import-text";

function More({ shown, count }: { shown: number; count: number }) {
  return count > shown ? <li className="muted">and {count - shown} more</li> : null;
}

/** A long list, folded: its summary says what's inside. */
function Fold({
  summary,
  children,
  testId,
}: {
  summary: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <details className="report-fold" data-testid={testId}>
      <summary>{summary}</summary>
      <ul className="report-list">{children}</ul>
    </details>
  );
}

function Paths({ list, summary }: { list: ImportPathList; summary: string }) {
  if (list.count === 0) return null;
  return (
    <Fold summary={summary}>
      {list.paths.map((path) => (
        <li key={path}>
          <code>{path}</code>
        </li>
      ))}
      <More shown={list.paths.length} count={list.count} />
    </Fold>
  );
}

function Moves({ list, summary }: { list: ImportMoveList; summary: string }) {
  if (list.count === 0) return null;
  return (
    <Fold summary={summary}>
      {list.items.map(({ from, to }) => (
        <li key={from}>
          <code>{from}</code>
          {to === from ? null : (
            <>
              {" → "}
              <code>{to}</code>
            </>
          )}
        </li>
      ))}
      <More shown={list.items.length} count={list.count} />
    </Fold>
  );
}

function Skipped({ list }: { list: ImportSkippedList }) {
  if (list.count === 0) return null;
  return (
    <Group title="Not copied">
      <Fold
        summary={`${pluralize(list.count, "file")} ${list.count === 1 ? "isn't" : "aren't"} copied`}
        testId="report-skipped"
      >
        {list.items.map(({ path, reason }) => (
          <li key={path}>
            <code>{path}</code> <span className="muted">— {SKIP_REASON[reason] ?? reason}</span>
          </li>
        ))}
        <More shown={list.items.length} count={list.count} />
      </Fold>
    </Group>
  );
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <li>
      <span className="report-fact-name">{name}</span>
      <span>{children}</span>
    </li>
  );
}

function Group({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="report-group" data-testid={testId}>
      <h4 className="report-group-title">{title}</h4>
      {children}
    </section>
  );
}

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="report-stat">
      <dt>{label}</dt>
      <dd>
        {value}
        {detail ? <span className="report-stat-detail">{detail}</span> : null}
      </dd>
    </div>
  );
}

export function Warnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="report-warnings" data-testid="report-warnings">
      {warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  );
}

/** What importing would do, from `POST /api/import/obsidian/preview`. */
export function PreviewReport({ preview }: { preview: ObsidianImportPreview }) {
  const { settings, templates, attachments } = preview;
  const editor = editorSettingsText(settings.editor, settings.vimrc);
  return (
    <div className="import-report" data-testid="import-report">
      <dl className="report-stats" data-testid="report-stats">
        <Stat label="Notes" value={preview.notes} />
        <Stat label="Folders" value={preview.folders} />
        <Stat
          label="Attachments"
          value={attachments.count}
          {...(attachments.count > 0 ? { detail: formatBytes(attachments.bytes) } : {})}
        />
        <Stat label="Canvases" value={preview.canvases.count} />
        <Stat label="Drawings" value={preview.drawings.count} />
        <Stat
          label="In all"
          value={pluralize(preview.files, "file")}
          detail={formatBytes(preview.bytes)}
        />
      </dl>
      {attachments.count > 0 ? (
        <p className="report-line muted">Attachments: {attachmentKinds(attachments)}.</p>
      ) : null}
      <Warnings warnings={preview.warnings} />

      <Group title="Settings from Obsidian" testId="report-settings">
        <ul className="report-facts">
          <Fact name="Daily notes">
            {settings.dailyNotes
              ? dailyNotesText(settings.dailyNotes)
              : "none: yours keep this vault's settings"}
          </Fact>
          {editor.length > 0 ? <Fact name="Editor">{joinWords(editor)}</Fact> : null}
          {settings.theme ? <Fact name="Theme">{settings.theme}</Fact> : null}
          <Fact name="Templates">
            {templates.folder
              ? `${pluralize(templates.count, "template")} in ${templates.folder}`
              : "no templates folder"}
          </Fact>
        </ul>
        {settings.files.length === 0 ? (
          <p className="report-line muted">No Obsidian settings were found.</p>
        ) : null}
      </Group>

      <Group title="Community plugins" testId="report-plugins">
        {preview.plugins.length === 0 ? (
          <p className="report-line muted">No community plugins are turned on.</p>
        ) : (
          <>
            <ul className="report-plugins">
              {preview.plugins.map((plugin) => {
                const support = SUPPORT[plugin.support] ?? SUPPORT.unknown;
                return (
                  <li key={plugin.id} className="report-plugin">
                    <span className="report-plugin-name">{plugin.name ?? plugin.id}</span>
                    <span className={cx("chip", `tone-${support.tone}`)}>{support.label}</span>
                    <span className="report-plugin-note">{plugin.note}</span>
                  </li>
                );
              })}
            </ul>
            <p className="report-line muted">
              Every plugin&apos;s files are copied, so they still work if you open the new vault in
              Obsidian.
            </p>
          </>
        )}
      </Group>

      {preview.canvases.count > 0 || preview.drawings.count > 0 ? (
        <Group title="Canvases and drawings" testId="report-canvases">
          {preview.canvases.count > 0 ? (
            <p className="report-line">
              {pluralize(preview.canvases.count, "canvas", "canvases")}: copied, but they don&apos;t
              open here yet (they still open in Obsidian).
            </p>
          ) : null}
          <Paths list={preview.canvases} summary="Show the canvases" />
          {preview.drawings.count > 0 ? (
            <p className="report-line">
              {pluralize(preview.drawings.count, "Excalidraw drawing")}: they open and edit here.
            </p>
          ) : null}
          <Paths list={preview.drawings} summary="Show the drawings" />
        </Group>
      ) : null}

      <CarryOver plan={preview.carryOver} />
      <Skipped list={preview.skipped} />
    </div>
  );
}

const DAILY_FROM: Record<CarryOverPlan["dailyNotesFrom"], string> = {
  obsidian: "as Obsidian keeps them",
  obsidian_defaults: "Obsidian's default place",
  daily_do_list: "as this vault keeps them",
};

/** What happens to the current vault's notes, routines and agent history. */
export function CarryOver({ plan }: { plan: CarryOverPlan }) {
  const { agent, daily } = plan;
  const otherNotes = plan.notes.count - plan.collisions.count;
  const history = [
    agent.threads > 0 ? pluralize(agent.threads, "thread") : "",
    agent.records > 0 ? pluralize(agent.records, "task record") : "",
    agent.approvals > 0 ? pluralize(agent.approvals, "approval") : "",
    agent.routines > 0 ? `the schedules of ${pluralize(agent.routines, "routine")}` : "",
  ].filter(Boolean);
  return (
    <Group title="Your Daily Do List notes" testId="report-carry-over">
      <p className="report-line">
        Your current vault, <code>{plan.vault}</code>, stays exactly as it is: it&apos;s your
        backup. Its notes are copied into the new vault.
      </p>
      <ul className="report-facts">
        <Fact name="Daily notes">
          {daily.count === 0
            ? "none to carry over."
            : `${pluralize(daily.count, "note")} move to ${dailyPlaceText(plan.dailyNotes)}, ${DAILY_FROM[plan.dailyNotesFrom] ?? plan.dailyNotesFrom}.`}
          {daily.merged > 0
            ? ` ${pluralize(daily.merged, "date is", "dates are")} in both vaults: Obsidian's note is kept, and yours is added at its end under “From Daily Do List”.`
            : null}
        </Fact>
        <Fact name="Other files">
          {otherNotes > 0 ? `${pluralize(otherNotes, "file")} keep their paths` : "none"}
          {plan.routines + plan.drawings > 0
            ? ` (${joinWords(
                [
                  plan.routines > 0 ? pluralize(plan.routines, "routine") : "",
                  plan.drawings > 0 ? pluralize(plan.drawings, "drawing") : "",
                ].filter(Boolean),
              )} among them)`
            : null}
          .
        </Fact>
        {plan.collisions.count > 0 ? (
          <Fact name="Same names">
            {pluralize(plan.collisions.count, "file")}{" "}
            {plan.collisions.count === 1 ? "has" : "have"} the name of an Obsidian file, so “(Daily
            Do List)” is added to {plan.collisions.count === 1 ? "it" : "them"}.
          </Fact>
        ) : null}
        <Fact name="Agent history">
          {history.length > 0 ? `${joinWords(history)} come along.` : "nothing to carry over."}
          {agent.detached > 0
            ? ` ${pluralize(agent.detached, "thread")} whose task isn't in its note any more ${agent.detached === 1 ? "is" : "are"} kept, marked detached.`
            : null}
        </Fact>
      </ul>
      {plan.watchedOpenTasks > 0 ? (
        <div className="report-callout" data-testid="report-watched-tasks">
          <strong>After the switch:</strong> Obsidian&apos;s daily notes have{" "}
          {pluralize(plan.watchedOpenTasks, "open task")} in the days the agent watches. The agent
          treats them as tasks that were already there, so{" "}
          {plan.actOnExistingTasks
            ? "it works on them: “Act on existing tasks” is on in Settings → Agent."
            : "it leaves them alone unless you edit them: “Act on existing tasks” is off."}
        </div>
      ) : null}
      {daily.count > 0 ? (
        <Fold summary="Show the daily notes">
          {daily.items.map(({ from, to, merged }) => (
            <li key={from}>
              <code>{from}</code> → <code>{to}</code>
              {merged ? <span className="chip report-merged">added to Obsidian&apos;s</span> : null}
            </li>
          ))}
          <More shown={daily.items.length} count={daily.count} />
        </Fold>
      ) : null}
      <Moves list={plan.notes} summary="Show the other files" />
      <Paths
        list={plan.leftBehind}
        summary={`${pluralize(plan.leftBehind.count, "hidden file")} stay behind in the current vault`}
      />
    </Group>
  );
}

/** What "Update from Obsidian" did. */
export function UpdateReport({ update }: { update: ObsidianUpdateReport }) {
  const changed =
    update.added.count + update.updated.count + update.restored.count + update.conflicts.count;
  return (
    <div className="import-report" data-testid="update-report">
      <p className="report-line">
        {changed === 0
          ? "Nothing changed in Obsidian since the last time."
          : `${joinWords(
              [
                update.added.count > 0 ? `${update.added.count} new` : "",
                update.updated.count > 0 ? `${update.updated.count} changed` : "",
                update.restored.count > 0 ? `${update.restored.count} brought back` : "",
                update.conflicts.count > 0
                  ? `${update.conflicts.count} changed in both places (both kept)`
                  : "",
              ].filter(Boolean),
            )}. ${pluralize(update.unchanged, "file")} unchanged.`}
      </p>
      <Paths list={update.added} summary={`New in Obsidian: ${update.added.count}`} />
      <Paths list={update.updated} summary={`Changed in Obsidian: ${update.updated.count}`} />
      <Paths
        list={update.restored}
        summary={`Deleted here, changed in Obsidian, brought back: ${update.restored.count}`}
      />
      <Moves
        list={update.conflicts}
        summary={`Changed in both places, Obsidian's version saved next to yours: ${update.conflicts.count}`}
      />
      <Paths
        list={update.deletedInSource}
        summary={`Deleted in Obsidian, kept here: ${update.deletedInSource.count}`}
      />
      <Skipped list={update.skipped} />
    </div>
  );
}
