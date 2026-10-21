package engine

import (
	"context"
	"testing"

	wfmodels "github.com/kandev/kandev/internal/workflow/models"
)

func poolQueueInput() ActionInput {
	step := CompileStep(&wfmodels.WorkflowStep{ID: "pool-step", WorkflowID: "pool-workflow", AgentProfileID: "fixed-profile",
		Events: wfmodels.StepEvents{OnEnter: []wfmodels.OnEnterAction{{Type: wfmodels.OnEnterQueueRun, Config: map[string]any{"pool_version": 1}}}}})
	return ActionInput{Trigger: TriggerOnEnter, State: MachineState{TaskID: "task"}, Step: step,
		Action: step.Events[TriggerOnEnter][0], EntryID: "entry:00000000000000000042"}
}

func TestPoolQueueRejectsMissingEntryAuthorityBeforePublishing(t *testing.T) {
	cases := []struct {
		name string
		edit func(*ActionInput)
	}{
		{"empty_entry", func(in *ActionInput) { in.EntryID = "" }},
		{"empty_task", func(in *ActionInput) { in.State.TaskID = "" }},
		{"empty_step", func(in *ActionInput) { in.Step.ID = "" }},
		{"wrong_trigger", func(in *ActionInput) { in.Trigger = TriggerOnTurnComplete }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := poolQueueInput()
			tc.edit(&in)
			adapter := &nativePoolQueueRecorder{outcome: QueueOutcomeQueued}
			_, err := (QueueRunCallback{Adapter: adapter}).Execute(context.Background(), in)
			if err == nil || len(adapter.requests) != 0 || len(adapter.ordinary) != 0 {
				t.Fatalf("缺少原生进入身份不得派发: pool=%d ordinary=%d err=%v", len(adapter.requests), len(adapter.ordinary), err)
			}
		})
	}
}

func TestPoolQueueDoesNotAcceptAnUnconfirmedQueueOutcome(t *testing.T) {
	for _, outcome := range []QueueOutcome{"", QueueOutcomeCoalesced, QueueOutcomeRateLimited} {
		t.Run(string(outcome), func(t *testing.T) {
			adapter := &nativePoolQueueRecorder{outcome: outcome}
			_, err := (QueueRunCallback{Adapter: adapter}).Execute(context.Background(), poolQueueInput())
			if err == nil || len(adapter.requests) != 1 || len(adapter.ordinary) != 0 {
				t.Fatalf("合并、限流或空结果不得当成池派发成功: outcome=%s pool=%d ordinary=%d err=%v", outcome, len(adapter.requests), len(adapter.ordinary), err)
			}
		})
	}
}
