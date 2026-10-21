package orchestrator

import (
	"context"

	"go.uber.org/zap"

	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

const maxPoolProjectionStamps = 128

type poolProjectionKey struct {
	TaskID  string
	RunID   string
	ClaimID string
	Domain  string
}

// ObservePoolCommit 复用已有原生后续工作所有者，避免在执行回调锁内重建摘要。
func (s *Service) ObservePoolCommit(change runsmodels.PoolProjectionCommit) {
	if s.eventBus == nil || change.TaskID == "" || change.RunID == "" || len(change.TaskID) > 256 ||
		len(change.RunID) > 256 || len(change.ClaimID) > 256 || !s.acceptPoolProjectionStamp(change) {
		return
	}
	s.startOwnedLifecycleFollowup(func(ctx context.Context) {
		event := bus.NewEvent(events.TaskPoolExecutionCommitted, "native-pool", map[string]any{"task_id": change.TaskID})
		if err := s.eventBus.Publish(ctx, events.TaskPoolExecutionCommitted, event); err != nil {
			s.logger.Warn("池摘要提交后通知未确认", zap.String("task_id", change.TaskID), zap.Error(err))
		}
	})
}

func (s *Service) acceptPoolProjectionStamp(change runsmodels.PoolProjectionCommit) bool {
	key := poolProjectionKey{TaskID: change.TaskID, RunID: change.RunID, ClaimID: change.ClaimID}
	if change.Kind == runsmodels.PoolProjectionHistoryCleaned {
		key.Domain = runsmodels.PoolProjectionHistoryCleaned
	}
	if change.Kind == runsmodels.PoolProjectionRecovery {
		key.Domain = runsmodels.PoolProjectionRecovery
	}
	s.poolProjectionMu.Lock()
	defer s.poolProjectionMu.Unlock()
	if s.poolProjectionSeen == nil {
		s.poolProjectionSeen = make(map[poolProjectionKey]int)
	}
	if previous, found := s.poolProjectionSeen[key]; found && previous >= change.Sequence {
		return false
	}
	if _, found := s.poolProjectionSeen[key]; !found {
		if len(s.poolProjectionOrder) == maxPoolProjectionStamps {
			delete(s.poolProjectionSeen, s.poolProjectionOrder[0])
			s.poolProjectionOrder = s.poolProjectionOrder[1:]
		}
		s.poolProjectionOrder = append(s.poolProjectionOrder, key)
	}
	s.poolProjectionSeen[key] = change.Sequence
	return true
}
