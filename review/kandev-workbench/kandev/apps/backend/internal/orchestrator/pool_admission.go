package orchestrator

import (
	"context"
	"sync"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

// PoolTaskStartGuard 由共享队列验证真实活动运行及宿主领取许可。
type PoolTaskStartGuard interface {
	CheckPoolTaskStart(context.Context, string) error
}

// PoolClaimStartGuard 仅由宿主队列签发一次性的当前领取启动意图。
type PoolClaimStartGuard interface {
	AdmitPoolClaimStart(context.Context, runsmodels.PoolClaimStart) error
}

// SetPoolTaskStartGuard 仅用于构造期；未接池执行的原生实例保持原启动行为。
func (s *Service) SetPoolTaskStartGuard(guard PoolTaskStartGuard) { s.poolTaskStartGuard = guard }

// WithPoolReleaseAdmission 在原生任务准入边界内提交批准，不持锁等待提供商。
func (s *Service) WithPoolReleaseAdmission(ctx context.Context, taskID string, fn func(context.Context) error) error {
	if fn == nil {
		return runsmodels.ErrPoolAdmissionUnavailable
	}
	return s.WithPoolEnqueueAdmission(ctx, taskID, func(admitted context.Context, preparing bool) error {
		if preparing {
			return runsmodels.ErrPoolTaskStartPreparing
		}
		return fn(admitted)
	})
}

// WithPoolEnqueueAdmission 让发布器在原生锁内区分已有身份重放与首次发布。
func (s *Service) WithPoolEnqueueAdmission(ctx context.Context, taskID string, fn func(context.Context, bool) error) error {
	if s == nil || taskID == "" || fn == nil {
		return runsmodels.ErrPoolAdmissionUnavailable
	}
	admitted, release := s.lockCeilingEntryAdmission(ctx, taskID)
	defer release()
	s.ceilingEntryAdmissionLocksMu.Lock()
	entry := s.ceilingEntryAdmissionLocks[taskID]
	preparing := entry != nil && entry.poolStarts > 0
	s.ceilingEntryAdmissionLocksMu.Unlock()
	return fn(admitted, preparing)
}

// beginPoolTaskStart 的引用跨越启动 I/O，任务锁仅覆盖短暂的准入与计数。
func (s *Service) beginPoolTaskStart(ctx context.Context, taskID string, claim *runsmodels.PoolClaimStart) (func(), error) {
	if s.poolTaskStartGuard == nil && claim == nil {
		return func() {}, nil
	}
	admitted, unlock := s.lockCeilingEntryAdmission(ctx, taskID)
	defer unlock()
	if err := s.checkPoolTaskStartGuard(admitted, taskID, claim); err != nil {
		return nil, err
	}
	s.ceilingEntryAdmissionLocksMu.Lock()
	entry := s.ceilingEntryAdmissionLocks[taskID]
	if entry == nil {
		s.ceilingEntryAdmissionLocksMu.Unlock()
		return nil, runsmodels.ErrPoolAdmissionUnavailable
	}
	entry.refs++
	entry.poolStarts++
	s.ceilingEntryAdmissionLocksMu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.ceilingEntryAdmissionLocksMu.Lock()
			entry.poolStarts--
			entry.refs--
			if entry.refs == 0 {
				delete(s.ceilingEntryAdmissionLocks, taskID)
			}
			s.ceilingEntryAdmissionLocksMu.Unlock()
		})
	}, nil
}

func (s *Service) checkPoolTaskStartGuard(ctx context.Context, taskID string, claim *runsmodels.PoolClaimStart) error {
	if claim == nil {
		return s.poolTaskStartGuard.CheckPoolTaskStart(ctx, taskID)
	}
	if !claim.Valid() || claim.Release.TaskID != taskID {
		return runsmodels.ErrPoolClaimStartConflict
	}
	guard, ok := s.poolTaskStartGuard.(PoolClaimStartGuard)
	if !ok {
		return runsmodels.ErrPoolAdmissionUnavailable
	}
	return guard.AdmitPoolClaimStart(ctx, *claim)
}
