package orchestrator

import (
	"context"
	"errors"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

type poolQuiescentAdmission interface {
	WithPoolExecutionQuiescence(context.Context, runsmodels.PoolExecutionIdentity, func(context.Context) error) error
}

type poolQuiescentManagerFake struct {
	*mockAgentManager
	seen [3]string
	err  error
}

func (m *poolQuiescentManagerFake) CheckExecutionQuiescent(_ context.Context, executionID, taskID, sessionID string) error {
	m.seen = [3]string{executionID, taskID, sessionID}
	return m.err
}

type poolQuiescentLSPFake struct{ busy bool }

func (l *poolQuiescentLSPFake) HasActiveLSPLease(string) bool             { return l.busy }
func (l *poolQuiescentLSPFake) HasActiveLSPLeaseForExecution(string) bool { return l.busy }
func (*poolQuiescentLSPFake) StopLSPLeasesForSession(string)              {}
func (*poolQuiescentLSPFake) StopLSPLeasesForTask(string)                 {}
func (*poolQuiescentLSPFake) StopLSPLeasesForExecution(string)            {}

type poolQuiescentStartGuard struct{}

func (poolQuiescentStartGuard) CheckPoolTaskStart(context.Context, string) error { return nil }

func poolQuiescentIdentity() runsmodels.PoolExecutionIdentity {
	return runsmodels.PoolExecutionIdentity{RunID: "run", ClaimID: "claim", TaskID: "task", SessionID: "session", ExecutionID: "execution", TurnID: "turn",
		AgentProfileID: "fixed-cli", ExecutionProfileID: "fixed-cli", PromptGeneration: 1}
}

func poolQuiescentAdmissionFor(t *testing.T, service *Service) poolQuiescentAdmission {
	t.Helper()
	admission, supported := any(service).(poolQuiescentAdmission)
	require.True(t, supported, "协调器缺少复用生命周期与任务准入的终结核验")
	return admission
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolQuiescentAdmissionUsesExistingFencesAndExactRuntimeScope(t *testing.T) {
	manager := &poolQuiescentManagerFake{mockAgentManager: &mockAgentManager{}}
	service := &Service{agentManager: manager}
	i := poolQuiescentIdentity()
	called := false
	err := poolQuiescentAdmissionFor(t, service).WithPoolExecutionQuiescence(context.Background(), i, func(ctx context.Context) error {
		called = true
		require.True(t, ceilingEntryAdmissionLockHeld(ctx, i.TaskID))
		unlock, acquired := service.tryAcquireSessionLifecycleLock(i.SessionID)
		if acquired {
			unlock()
		}
		require.False(t, acquired, "回调期间必须仍持原生生命周期屏障，不能与 LSP 新准入竞争")
		return nil
	})
	require.NoError(t, err)
	require.True(t, called)
	require.Equal(t, [3]string{i.ExecutionID, i.TaskID, i.SessionID}, manager.seen)
}

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolQuiescentAdmissionRefusesBusyOrUnmeasurableScope(t *testing.T) {
	for _, mode := range []string{"missing-capability", "runtime-busy", "lsp-busy", "preparing", "lifecycle-held"} {
		t.Run(mode, func(t *testing.T) {
			manager := &poolQuiescentManagerFake{mockAgentManager: &mockAgentManager{}}
			service := &Service{agentManager: manager}
			i := poolQuiescentIdentity()
			switch mode {
			case "missing-capability":
				service.agentManager = &mockAgentManager{}
			case "runtime-busy":
				manager.err = errors.New("runtime-busy")
			case "lsp-busy":
				service.SetLSPLeaseLifecycle(&poolQuiescentLSPFake{busy: true})
			case "preparing":
				service.SetPoolTaskStartGuard(poolQuiescentStartGuard{})
				release, err := service.beginPoolTaskStart(context.Background(), i.TaskID, nil)
				require.NoError(t, err)
				t.Cleanup(release)
			case "lifecycle-held":
				t.Cleanup(service.AcquireSessionLifecycleFence(i.SessionID))
			}
			called := false
			err := poolQuiescentAdmissionFor(t, service).WithPoolExecutionQuiescence(context.Background(), i, func(context.Context) error { called = true; return nil })
			require.Error(t, err)
			require.False(t, called)
		})
	}
}
