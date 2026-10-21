package engine

import (
	"context"
	"errors"
	"testing"

	wfmodels "github.com/kandev/kandev/internal/workflow/models"
)

type poolQueueBoundaryRecorder struct{ ordinary []QueueRunRequest }

func (r *poolQueueBoundaryRecorder) QueueRun(_ context.Context, req QueueRunRequest) (QueueOutcome, error) {
	r.ordinary = append(r.ordinary, req)
	return QueueOutcomeQueued, nil
}

type nativePoolQueueRecorder struct {
	poolQueueBoundaryRecorder
	requests []PoolQueueRequest
	outcome  QueueOutcome
	err      error
}

func (r *nativePoolQueueRecorder) QueuePoolRun(_ context.Context, req PoolQueueRequest) (QueueOutcome, error) {
	r.requests = append(r.requests, req)
	return r.outcome, r.err
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolQueueUsesNativeEntryPublisherWithoutAuthoredEnvelope(t *testing.T) {
	step := CompileStep(&wfmodels.WorkflowStep{ID: "pool-step", WorkflowID: "pool-workflow", AgentProfileID: "compiled-profile",
		Events: wfmodels.StepEvents{OnEnter: []wfmodels.OnEnterAction{{Type: wfmodels.OnEnterQueueRun, Config: map[string]any{"pool_version": 1}}}}})
	for _, outcome := range []QueueOutcome{QueueOutcomeQueued, QueueOutcomeDeduped} {
		t.Run(string(outcome), func(t *testing.T) {
			adapter := &nativePoolQueueRecorder{outcome: outcome}
			callback := QueueRunCallback{Adapter: adapter, Primary: adapter}
			_, err := callback.Execute(context.Background(), ActionInput{Trigger: TriggerOnEnter,
				State: MachineState{TaskID: "native-task", WorkflowID: "pool-workflow", AgentProfileID: "not-authority"}, Step: step,
				Action: step.Events[TriggerOnEnter][0], EntryID: "entry:00000000000000000042",
				Payload: map[string]any{"agent_profile_id": "forged", "claim_id": "forged", "started_at": "forged"}})
			if err != nil || len(adapter.ordinary) != 0 || len(adapter.requests) != 1 ||
				adapter.requests[0] != (PoolQueueRequest{TaskID: "native-task", WorkflowStepID: "pool-step", EntryID: "entry:00000000000000000042"}) {
				t.Fatalf("只能提交原生 task/step/entry 身份: ordinary=%d pool=%+v err=%v", len(adapter.ordinary), adapter.requests, err)
			}
		})
	}
}

func TestPoolQueueDoesNotTurnPublisherFailureIntoOrdinaryWake(t *testing.T) {
	step := CompileStep(&wfmodels.WorkflowStep{ID: "pool-step", WorkflowID: "pool-workflow", AgentProfileID: "fixed-profile",
		Events: wfmodels.StepEvents{OnEnter: []wfmodels.OnEnterAction{{Type: wfmodels.OnEnterQueueRun, Config: map[string]any{"pool_version": 1}}}}})
	failure := errors.New("native-publisher-failed")
	adapter := &nativePoolQueueRecorder{err: failure}
	_, err := (QueueRunCallback{Adapter: adapter}).Execute(context.Background(), ActionInput{Trigger: TriggerOnEnter,
		State: MachineState{TaskID: "task"}, Step: step, Action: step.Events[TriggerOnEnter][0], EntryID: "entry:00000000000000000042"})
	if !errors.Is(err, failure) || len(adapter.requests) != 1 || len(adapter.ordinary) != 0 {
		t.Fatalf("派发失败必须保留失败，不能另走普通队列: pool=%d ordinary=%d err=%v", len(adapter.requests), len(adapter.ordinary), err)
	}
}

func (r *poolQueueBoundaryRecorder) PrimaryAgentProfileID(context.Context, string, string) (string, error) {
	return "fixed-profile", nil
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-005.4
func TestPoolQueueWithoutNativePublisherDoesNotFallBack(t *testing.T) {
	for _, marked := range []bool{false, true} {
		name := "ordinary"
		config := map[string]any{}
		if marked {
			name = "pool"
			config["pool_version"] = 1
		}
		t.Run(name, func(t *testing.T) {
			step := CompileStep(&wfmodels.WorkflowStep{ID: "step", WorkflowID: "workflow", AgentProfileID: "fixed-profile",
				Events: wfmodels.StepEvents{OnEnter: []wfmodels.OnEnterAction{{Type: wfmodels.OnEnterQueueRun, Config: config}}}})
			adapter := &poolQueueBoundaryRecorder{}
			callback := QueueRunCallback{Adapter: adapter, Primary: adapter}
			_, err := callback.Execute(context.Background(), ActionInput{Trigger: TriggerOnEnter,
				State: MachineState{TaskID: "task", WorkflowID: "workflow"}, Step: step,
				Action: step.Events[TriggerOnEnter][0], EntryID: "entry:00000000000000000042"})
			if marked {
				if err == nil || len(adapter.ordinary) != 0 {
					t.Fatalf("池发布器未就绪不得降级成普通唤醒: calls=%d err=%v", len(adapter.ordinary), err)
				}
			} else if err != nil || len(adapter.ordinary) != 1 {
				t.Fatalf("普通流程正对照失败: calls=%d err=%v", len(adapter.ordinary), err)
			}
		})
	}
}
