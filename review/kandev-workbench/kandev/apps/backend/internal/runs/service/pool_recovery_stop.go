package service

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/runs/models"
)

type poolRecoveryStopAdmission interface {
	WithPoolRecoveryStop(context.Context, models.PoolExecutionIdentity, func(context.Context) (bool, error)) error
}

type poolRecoveryExecutionSource interface {
	CheckPoolRecoveryExecutionTx(context.Context, *sqlx.Tx, models.PoolExecutionIdentity) error
}

func recoveryStopOperation(snapshot poolRecoveryRead, actor string, command models.PoolRecoveryCommand, identity models.PoolExecutionIdentity) models.PoolRecoveryOperation {
	return models.PoolRecoveryOperation{Command: command, TaskID: snapshot.header.TaskID, WorkspaceID: snapshot.header.WorkspaceID,
		ActorID: actor, EntryID: snapshot.release.EntryID, Result: "stop_requested", ClaimID: identity.ClaimID, Execution: identity}
}

func (s *Service) recoveryStopReplayTx(ctx context.Context, tx *sqlx.Tx, snapshot poolRecoveryRead, actor string, command models.PoolRecoveryCommand) (*models.RunEvent, error) {
	previous, err := s.repo.FindPoolRecoveryOperationTx(ctx, tx, command.RunID, command.OperationID)
	if err != nil || previous == nil {
		return previous, err
	}
	var stored models.PoolRecoveryOperation
	if json.Unmarshal([]byte(previous.Payload), &stored) != nil || previous.EventType != models.PoolRecoveryStopRequested ||
		stored != recoveryStopOperation(snapshot, actor, command, stored.Execution) {
		return nil, models.ErrPoolRecoveryConflict
	}
	request := models.PoolClaimStart{RunID: command.RunID, ClaimID: command.ExpectedClaimID, Release: snapshot.release}
	if !stored.Execution.ValidAllocationFor(request) {
		return nil, models.ErrPoolRecoveryConflict
	}
	return previous, nil
}

func (s *Service) readPoolRecoveryStop(ctx context.Context, taskID, actor string, command models.PoolRecoveryCommand) (models.PoolExecutionIdentity, *models.RunEvent, error) {
	var identity models.PoolExecutionIdentity
	var previous *models.RunEvent
	err := s.withPoolRecoveryRead(ctx, taskID, command.RunID, func(ctx context.Context, tx *sqlx.Tx, snapshot poolRecoveryRead) error {
		var err error
		previous, err = s.recoveryStopReplayTx(ctx, tx, snapshot, actor, command)
		if err != nil || previous != nil {
			return err
		}
		if err := s.validatePoolRecoveryVersionsTx(ctx, tx, snapshot, command); err != nil {
			return err
		}
		identity, err = s.repo.PoolRecoveryExecutionTx(ctx, tx, snapshot.run, command.ExpectedClaimID)
		return err
	})
	return identity, previous, err
}

func (s *Service) recoverPoolStop(ctx context.Context, source poolRecoveryTaskSource, taskID, actor string, command models.PoolRecoveryCommand) (*models.RunEvent, error) {
	identity, previous, err := s.readPoolRecoveryStop(ctx, taskID, actor, command)
	if err != nil || previous != nil {
		return previous, err
	}
	admission, admitted := s.poolEnqueueAdmission.(poolRecoveryStopAdmission)
	executions, supported := s.poolReleaseSource.(poolRecoveryExecutionSource)
	if !admitted || !supported {
		return nil, models.ErrPoolAdmissionUnavailable
	}
	var event *models.RunEvent
	var committed bool
	err = admission.WithPoolRecoveryStop(ctx, identity, func(admitted context.Context) (bool, error) {
		var err error
		event, committed, err = s.recordPoolRecoveryStop(admitted, source, executions, identity, actor, command)
		return committed, err
	})
	if err != nil {
		return nil, err
	}
	s.notifyPoolRecovery(taskID, event, committed)
	return event, nil
}

func (s *Service) recordPoolRecoveryStop(ctx context.Context, source poolRecoveryTaskSource, executions poolRecoveryExecutionSource, identity models.PoolExecutionIdentity, actor string, command models.PoolRecoveryCommand) (*models.RunEvent, bool, error) {
	tx, err := s.repo.BeginEnqueueTx(ctx, "")
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.repo.LockPoolTaskTx(ctx, tx, identity.TaskID); err != nil {
		return nil, false, err
	}
	snapshot, err := s.loadPoolRecoverySnapshotTx(ctx, tx, source, identity.TaskID, command.RunID)
	if err != nil {
		return nil, false, err
	}
	previous, err := s.recoveryStopReplayTx(ctx, tx, snapshot, actor, command)
	if err != nil || previous != nil {
		return previous, false, err
	}
	if err := checkPoolRecoveryManager(snapshot.header, actor, command.ExpectedManagementVersion); err != nil {
		return nil, false, err
	}
	if err := s.validatePoolRecoveryVersionsTx(ctx, tx, snapshot, command); err != nil {
		return nil, false, err
	}
	if err := executions.CheckPoolRecoveryExecutionTx(ctx, tx, identity); err != nil {
		return nil, false, err
	}
	event, err := s.repo.AppendPoolRecoveryStopTx(ctx, tx, snapshot.run, recoveryStopOperation(snapshot, actor, command, identity))
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return event, true, nil
}
