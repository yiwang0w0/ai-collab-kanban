package orchestrator

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	"github.com/kandev/kandev/internal/orchestrator/watcher"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	"github.com/stretchr/testify/require"
)

type poolStopFinishResult struct {
	identity runsmodels.PoolExecutionIdentity
	err      error
}

type poolStopFinalizeGuard struct {
	service  *Service
	repo     *tasksqlite.Repository
	identity runsmodels.PoolExecutionIdentity
	entered  chan struct{}
	finished chan poolStopFinishResult
}

func (*poolStopFinalizeGuard) CheckPoolTaskStart(context.Context, string) error { return nil }

func (g *poolStopFinalizeGuard) ObservePoolExecutionStopped(context.Context, runsmodels.PoolExecutionActivity, string, string, bool) (*runsmodels.RunEvent, error) {
	encoded, err := json.Marshal(runsmodels.PoolExecutionStopReceipt{PoolExecutionIdentity: g.identity,
		Source: runsmodels.PoolStopStandaloneControl, RuntimeInstanceID: "control-instance", ExecutionActivityReleased: true})
	return &runsmodels.RunEvent{RunID: g.identity.RunID, Payload: string(encoded)}, err
}

func (g *poolStopFinalizeGuard) FinalizeStoppedPoolRun(ctx context.Context, identity runsmodels.PoolExecutionIdentity) (*runsmodels.RunEvent, error) {
	close(g.entered)
	err := g.service.WithPoolExecutionQuiescence(ctx, identity, func(context.Context) error { return nil })
	g.finished <- poolStopFinishResult{identity: identity, err: err}
	return nil, err
}

func newPoolStopFinalizeFixture(t *testing.T) (*Service, *poolStopFinalizeGuard, watcher.AgentEventData) {
	t.Helper()
	repo := setupTestRepo(t)
	seedSession(t, repo, "t1", "s1", "step1")
	service := createTestService(repo, newMockStepGetter(), newMockTaskRepo())
	service.turnService = &repoTurnService{repo: repo}
	turn, err := service.turnService.StartTurn(context.Background(), "s1")
	require.NoError(t, err)
	identity := poolQuiescentIdentity()
	identity.TaskID, identity.SessionID, identity.TurnID = "t1", "s1", turn.ID
	guard := &poolStopFinalizeGuard{service: service, repo: repo, identity: identity, entered: make(chan struct{}), finished: make(chan poolStopFinishResult, 1)}
	service.SetPoolTaskStartGuard(guard)
	service.agentManager = &poolQuiescentManagerFake{mockAgentManager: &mockAgentManager{}}
	t.Cleanup(service.stopDynamicSuccessorWorkers)
	data := watcher.AgentEventData{TaskID: identity.TaskID, SessionID: identity.SessionID, AgentExecutionID: identity.ExecutionID,
		OwnerKind: string(lifecycle.ExecutionOwnerTask), AgentID: "claude-acp", AgentProfileID: identity.AgentProfileID,
		ExecutionProfileID: identity.ExecutionProfileID, TurnID: identity.TurnID, PromptGeneration: 1,
		RuntimeStopConfirmation: &lifecycle.RuntimeStopConfirmation{Source: lifecycle.RuntimeStopSourceStandaloneControl,
			RuntimeInstanceID: "control-instance", ExecutionActivityReleased: true}}
	return service, guard, data
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolStoppedFinalizationWaitsForNativeCallerWithoutBlockingEvent(t *testing.T) {
	service, guard, data := newPoolStopFinalizeFixture(t)
	unlock := service.AcquireSessionLifecycleFence(data.SessionID)
	service.handleAgentStopped(context.Background(), data)
	select {
	case <-guard.entered:
	case <-time.After(5 * time.Second):
		unlock()
		t.Fatal("停止后的终结未交给受宿主关闭管理的后续工作")
	}
	require.Zero(t, openTurnCount(t, guard.repo, data.SessionID), "先完成原生回合收尾，再尝试终结领取")
	select {
	case result := <-guard.finished:
		unlock()
		t.Fatalf("原生调用者尚持屏障时不应结束: %v", result.err)
	default:
	}
	unlock()
	select {
	case result := <-guard.finished:
		require.NoError(t, result.err)
		require.Equal(t, guard.identity, result.identity)
	case <-time.After(5 * time.Second):
		t.Fatal("原生屏障释放后未核验当前领取")
	}
}

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolStoppedFinalizationCancelGuardWaitAlsoDrainsOnShutdown(t *testing.T) {
	service, guard, data := newPoolStopFinalizeFixture(t)
	lock, release := service.acquireCancelInFlightGuard(data.SessionID)
	lock.Lock()
	defer release()
	defer lock.Unlock()
	service.handleAgentStopped(context.Background(), data)
	service.stopDynamicSuccessorWorkers()
	require.Equal(t, 1, openTurnCount(t, guard.repo, data.SessionID), "关闭取消等待，不在未取得收尾屏障时更新回合")
	select {
	case <-guard.entered:
		t.Fatal("未完成原生收尾不能进入终结")
	default:
	}
}

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolStoppedFinalizationWaitIsCancelledByNativeOwner(t *testing.T) {
	service, guard, data := newPoolStopFinalizeFixture(t)
	defer service.AcquireSessionLifecycleFence(data.SessionID)()
	service.handleAgentStopped(context.Background(), data)
	select {
	case <-guard.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("未启动受控终结核验")
	}
	service.stopDynamicSuccessorWorkers()
	select {
	case result := <-guard.finished:
		require.ErrorIs(t, result.err, context.Canceled, "关闭不能等锁到超时或签发成功")
	default:
		t.Fatal("关闭未排空等待中的后续工作")
	}
}
