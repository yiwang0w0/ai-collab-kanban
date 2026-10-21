package service

import (
	"context"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

// PoolExecutionAllocationSource 由任务仓储核对原生会话、回合、CLI 与当前占用。
type PoolExecutionAllocationSource interface {
	CheckPoolExecutionAllocationTx(context.Context, *sqlx.Tx, models.PoolReleaseSnapshot, models.PoolExecutionIdentity) (string, error)
}

// BindPoolExecution 仅由进程前的宿主执行分配接点调用，失败必须阻止进程启动。
func (s *Service) BindPoolExecution(ctx context.Context, request models.PoolClaimStart, identity models.PoolExecutionIdentity) (*models.RunEvent, error) {
	if !identity.ValidAllocationFor(request) {
		return nil, models.ErrPoolClaimStartConflict
	}
	source, ok := s.poolReleaseSource.(PoolExecutionAllocationSource)
	if !ok || s.poolEnqueueAdmission == nil || dialect.IsPostgres(s.repo.Writer().DriverName()) {
		return nil, models.ErrPoolAdmissionUnavailable
	}
	var event *models.RunEvent
	err := s.poolEnqueueAdmission.WithPoolEnqueueAdmission(ctx, identity.TaskID, func(admitted context.Context, _ bool) error {
		var err error
		event, err = s.bindPoolExecutionTx(admitted, source, request, identity)
		return err
	})
	if err == nil {
		s.notifyPoolProjection(identity.TaskID, event)
	}
	return event, err
}

func (s *Service) bindPoolExecutionTx(ctx context.Context, source PoolExecutionAllocationSource, request models.PoolClaimStart, identity models.PoolExecutionIdentity) (*models.RunEvent, error) {
	tx, err := s.repo.BeginEnqueueTx(ctx, "")
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.repo.LockPoolTaskTx(ctx, tx, identity.TaskID); err != nil {
		return nil, err
	}
	release, err := s.poolReleaseSource.LoadPoolReleaseTx(ctx, tx, identity.TaskID, request.Release.EntryID)
	if err != nil || release != request.Release {
		if err == nil {
			err = models.ErrPoolClaimStartConflict
		}
		return nil, err
	}
	agentType, err := source.CheckPoolExecutionAllocationTx(ctx, tx, release, identity)
	if err != nil {
		return nil, err
	}
	event, err := s.repo.AppendPoolExecutionAllocationTx(ctx, tx, request, models.PoolExecutionAllocation{
		PoolExecutionIdentity: identity, AgentType: agentType})
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return event, nil
}
