import {
  type CreateRoutineRequest,
  describeSchedulePhrase,
  ROUTINE_INSTRUCTIONS_MAX_LENGTH,
  ROUTINE_NAME_MAX_LENGTH,
  ROUTINE_NOTIFY_VALUES,
  type RoutineNotify,
  type RoutineTemplate,
  type RoutineUse,
} from "@ddl/core";
import { Check, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useServices } from "../../app/services";
import { KEYS, matchHotkey } from "../../commands/hotkeys";
import { IconButton } from "../../components/IconButton";
import { cx } from "../../lib/cx";
import { IS_MAC } from "../../lib/platform";
import { useRoutinesStore } from "../../state/routines-store";
import { type RoutineDraft, ui } from "../../state/ui-store";
import { Modal } from "../overlays/Modal";
import type { CreateProblem, RoutineField } from "./routine-errors";
import { NOTIFY_LABELS } from "./routine-format";
import "../../styles/routines.css";

interface Form {
  name: string;
  schedule: string;
  instructions: string;
  notify: RoutineNotify;
  uses: RoutineUse[];
  templateId: string | null;
}

const SCHEDULE_HINT =
  "In words, like “every weekday at 7:30”, “every 2 hours” or “every month on the 1st at 9:00”.";

function formFrom(draft: RoutineDraft | undefined): Form {
  return {
    name: draft?.name ?? "",
    schedule: draft?.schedule ?? "",
    instructions: draft?.instructions ?? "",
    notify: draft?.notify ?? "always",
    uses: draft?.uses ?? [],
    templateId: null,
  };
}

/**
 * "New routine": a starter template or a blank one, with a name, a schedule in words (the
 * daemon's reason shows under it when it can't read it), instructions and when to be told. From
 * "Repeat this" it starts from the task and waits for the user's schedule.
 */
export function NewRoutineDialog({ draft }: { draft?: RoutineDraft }) {
  const { routines: actions } = useServices();
  const repeating = draft?.fromThreadId !== undefined;
  const [form, setForm] = useState(() => formFrom(draft));
  const [problem, setProblem] = useState<CreateProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const scheduleRef = useRef<HTMLInputElement>(null);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const title = repeating ? "Repeat this task" : "New routine";
  const preview = useMemo(() => describeSchedulePhrase(form.schedule), [form.schedule]);
  const ready =
    form.name.trim() !== "" && form.schedule.trim() !== "" && form.instructions.trim() !== "";

  useEffect(() => {
    if (!repeating) void actions.ensureLoaded();
  }, [actions, repeating]);

  // After the modal's own effect, which would pick the first button (Close).
  useEffect(() => {
    (repeating ? scheduleRef : nameRef).current?.focus();
  }, [repeating]);

  const change = (field: RoutineField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (problem && (problem.field === field || problem.field === null)) setProblem(null);
  };

  const pick = (template: RoutineTemplate) => {
    setForm({
      name: template.name,
      schedule: template.schedule,
      instructions: template.instructions,
      notify: template.notify,
      uses: [...template.uses],
      templateId: template.id,
    });
    setProblem(null);
  };

  const submit = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setProblem(null);
    const request: CreateRoutineRequest = {
      name: form.name.trim(),
      schedule: form.schedule.trim(),
      instructions: form.instructions.trim(),
      notify: form.notify,
      ...(form.uses.length > 0 ? { uses: form.uses } : {}),
    };
    const result = await actions.create(request);
    setSaving(false);
    if (!result.ok) {
      setProblem(result.problem);
      const field = result.problem.field;
      if (field === "name") nameRef.current?.focus();
      else if (field === "schedule") scheduleRef.current?.focus();
      else if (field === "instructions") instructionsRef.current?.focus();
      return;
    }
    ui.closeOverlay();
    ui.showRoutine(result.routine.id);
  };

  const fieldProblem = (field: RoutineField) =>
    problem?.field === field ? (
      <span className="routine-error" role="alert" data-testid={`routine-${field}-problem`}>
        {problem.message}
      </span>
    ) : null;

  return (
    <Modal label={title} className="routine-dialog" testId="new-routine-dialog">
      <form
        className="routine-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header className="routine-dialog-header" data-tooltip-placement="bottom">
          <h2 className="modal-title">{title}</h2>
          <IconButton
            icon={X}
            label="Close"
            keys="escape"
            onClick={() => ui.closeOverlay()}
            data-testid="routine-close"
          />
        </header>
        <p className="routine-dialog-hint">
          {repeating
            ? "The agent will do this again on a schedule. Say when it should run."
            : "A job the agent does on a schedule. It's saved as a note in the Routines folder, so you can change it any time."}
        </p>
        {repeating ? null : <TemplatePicker selected={form.templateId} onPick={pick} />}
        <div className="routine-field">
          <label className="routine-label" htmlFor={`${id}-name`}>
            Name
          </label>
          <input
            ref={nameRef}
            id={`${id}-name`}
            className="input"
            value={form.name}
            maxLength={ROUTINE_NAME_MAX_LENGTH}
            placeholder="Morning briefing"
            spellCheck={false}
            aria-describedby={`${id}-name-help`}
            data-testid="routine-name-input"
            onChange={(event) => change("name", event.target.value)}
          />
          {fieldProblem("name") ?? (
            <span className="routine-help" id={`${id}-name-help`}>
              {form.name.trim() ? `Saved as Routines/${form.name.trim()}.md` : "Its file's name."}
            </span>
          )}
        </div>
        <div className="routine-field">
          <label className="routine-label" htmlFor={`${id}-schedule`}>
            Schedule
          </label>
          <input
            ref={scheduleRef}
            id={`${id}-schedule`}
            className="input"
            value={form.schedule}
            placeholder="every weekday at 7:30"
            spellCheck={false}
            aria-describedby={`${id}-schedule-help`}
            data-testid="routine-schedule-input"
            onChange={(event) => change("schedule", event.target.value)}
          />
          {fieldProblem("schedule") ??
            (preview ? (
              <span
                className="routine-help routine-preview"
                id={`${id}-schedule-help`}
                data-testid="routine-schedule-preview"
              >
                <Check size={12} strokeWidth={2} aria-hidden="true" />
                {preview}
              </span>
            ) : (
              <span className="routine-help" id={`${id}-schedule-help`}>
                {SCHEDULE_HINT}
              </span>
            ))}
        </div>
        <div className="routine-field">
          <label className="routine-label" htmlFor={`${id}-instructions`}>
            Instructions
          </label>
          <textarea
            ref={instructionsRef}
            id={`${id}-instructions`}
            className="textarea routine-instructions-input"
            value={form.instructions}
            rows={4}
            maxLength={ROUTINE_INSTRUCTIONS_MAX_LENGTH}
            placeholder="What should the agent do each time?"
            data-testid="routine-instructions-input"
            onChange={(event) => change("instructions", event.target.value)}
            onKeyDown={(event) => {
              if (matchHotkey(KEYS.modEnter, event.nativeEvent, IS_MAC)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {fieldProblem("instructions")}
        </div>
        <fieldset className="routine-field routine-notify">
          <legend className="routine-label">Tell me</legend>
          <div className="routine-segmented">
            {ROUTINE_NOTIFY_VALUES.map((value) => (
              <label
                key={value}
                className={cx("routine-segment", form.notify === value && "is-active")}
                data-testid={`routine-notify-${value}`}
              >
                <input
                  type="radio"
                  name={`${id}-notify`}
                  value={value}
                  checked={form.notify === value}
                  onChange={() => setForm((current) => ({ ...current, notify: value }))}
                />
                {NOTIFY_LABELS[value]}
              </label>
            ))}
          </div>
          {form.uses.length > 0 ? (
            <span className="routine-help">It can use: {form.uses.join(", ")}.</span>
          ) : null}
        </fieldset>
        {problem?.field === null ? (
          <p className="routine-error" role="alert" data-testid="routine-form-problem">
            {problem.message}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            data-testid="routine-cancel"
            onClick={() => ui.closeOverlay()}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button is-primary"
            disabled={!ready || saving}
            data-testid="routine-create"
            data-tooltip="Save it in the Routines folder"
            data-tooltip-keys="modEnter"
          >
            {saving ? "Creating…" : "Create routine"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TemplatePicker({
  selected,
  onPick,
}: {
  selected: string | null;
  onPick(template: RoutineTemplate): void;
}) {
  const templates = useRoutinesStore((s) => s.templates);
  const loaded = useRoutinesStore((s) => s.templatesLoaded);
  const failed = useRoutinesStore((s) => s.status === "error");
  if (failed && !loaded) return null;
  return (
    <div className="routine-field">
      <span className="routine-label">Start from a template</span>
      {loaded ? (
        <div className="routine-templates" data-testid="routine-templates">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className={cx("routine-template", selected === template.id && "is-active")}
              aria-pressed={selected === template.id}
              data-testid="routine-template"
              data-template-id={template.id}
              onClick={() => onPick(template)}
            >
              <span className="routine-template-name">{template.name}</span>
              <span className="routine-template-description">{template.description}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="routine-templates-loading" aria-busy="true" />
      )}
    </div>
  );
}
