package orchestrator

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kandev/kandev/internal/orchestrator/executor"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

type poolExecutionGuardFake struct {
	poolStartGuardFunc
	bind func(context.Context, runsmodels.PoolClaimStart, runsmodels.PoolExecutionIdentity) (*runsmodels.RunEvent, error)
}

func (f poolExecutionGuardFake) BindPoolExecution(ctx context.Context, request runsmodels.PoolClaimStart, identity runsmodels.PoolExecutionIdentity) (*runsmodels.RunEvent, error) {
	return f.bind(ctx, request, identity)
}
func (poolExecutionGuardFake) ObservePoolActivity(context.Context, runsmodels.PoolExecutionActivity) (*runsmodels.RunEvent, error) {
	return nil, nil
}

type poolCaptureManagerFake struct {
	executor.AgentManagerClient
	called int
}

func (m *poolCaptureManagerFake) EnableWorkActivity(_ context.Context, executionID, turnID string) error {
	m.called++
	if executionID != "actual-execution" || turnID != "actual-turn" {
		return runsmodels.ErrPoolClaimStartConflict
	}
	return nil
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-005.4
func TestPoolExecutionAdmissionRejectsMissingCapabilityOrUnboundAcknowledgement(t *testing.T) {
	for _, kind := range []string{"valid", "no-binder", "no-capture", "nil-event", "wrong-run", "wrong-execution", "wrong-type", "malformed"} {
		t.Run(kind, func(t *testing.T) {
			request, err := poolStartShape(t).PoolStartRequest()
			require.NoError(t, err)
			capture := &poolCaptureManagerFake{}
			svc := &Service{agentManager: capture}
			guard := poolExecutionGuardFake{bind: func(_ context.Context, _ runsmodels.PoolClaimStart, identity runsmodels.PoolExecutionIdentity) (*runsmodels.RunEvent, error) {
				stored := identity
				if kind == "wrong-execution" {
					stored.ExecutionID = "unbound-execution"
				}
				payload, err := json.Marshal(runsmodels.PoolExecutionAllocation{PoolExecutionIdentity: stored, AgentType: "claude-acp"})
				require.NoError(t, err)
				event := &runsmodels.RunEvent{RunID: request.RunID, EventType: runsmodels.PoolExecutionAllocated, Payload: string(payload)}
				switch kind {
				case "nil-event":
					return nil, nil
				case "wrong-run":
					event.RunID = "other-run"
				case "wrong-type":
					event.EventType = "step"
				case "malformed":
					event.Payload = "broken-json"
				}
				return event, nil
			}}
			svc.poolTaskStartGuard = guard
			if kind == "no-binder" {
				svc.poolTaskStartGuard = poolStartGuardFunc(func(context.Context, string) error { return nil })
			}
			if kind == "no-capture" {
				svc.agentManager = nil
			}
			admit := svc.poolExecutionStartAdmission(context.Background(), &request, "actual-session", "actual-turn", request.Release.AgentProfileID)
			err = admit("actual-execution")
			if kind == "valid" {
				require.NoError(t, err)
				require.Equal(t, 1, capture.called)
			} else {
				require.Error(t, err)
				require.Zero(t, capture.called, "未得到同一执行的持久分配时不能开启原生活动捕获")
			}
		})
	}
}
