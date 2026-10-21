package service

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/runs/models"
)

func recoveryRetryOperation(snapshot poolRecoveryRead, actor string, command models.PoolRecoveryCommand, identity models.PoolExecutionIdentity, finishedSeq int) models.PoolRecoveryOperation {
	return models.PoolRecoveryOperation{Command: command, TaskID: snapshot.header.TaskID, WorkspaceID: snapshot.header.WorkspaceID,
		ActorID: actor, EntryID: snapshot.release.EntryID, Result: "requeued", ClaimID: identity.ClaimID, Execution: identity, FinishedSeq: finishedSeq}
}

func (s *Service) recoveryRetryReplayTx(ctx context.Context, tx *sqlx.Tx, snapshot poolRecoveryRead, actor string, command models.PoolRecoveryCommand) (*models.RunEvent, error) {
	previous, err := s.repo.FindPoolRecoveryOperationTx(ctx, tx, command.RunID, command.OperationID)
	if err != nil || previous == nil {
		return previous, err
	}
	var stored models.PoolRecoveryOperation
	request := models.PoolClaimStart{RunID: command.RunID, ClaimID: command.ExpectedClaimID, Release: snapshot.release}
	if json.Unmarshal([]byte(previous.Payload), &stored) != nil || previous.EventType != models.PoolRecoveryRequeued ||
		stored != recoveryRetryOperation(snapshot, actor, command, stored.Execution, stored.FinishedSeq) || !stored.ValidExecutionFor(request) {
		return nil, models.ErrPoolRecoveryConflict
	}
	return previous, nil
}

func (s *Service) readPoolRecoveryRetry(ctx context.Context, taskID, actor string, command models.PoolRecoveryCommand) (models.PoolExecutionIdentity, *models.RunEvent, error) {
	var identity models.PoolExecutionIdentity
	var previous *models.RunEvent
	err := s.withPoolRecoveryRead(ctx, taskID, command.RunID, func(ctx context.Context, tx *sqlx.Tx, snapshot poolRecoveryRead) error {
		var err error
		previous, err = s.recoveryRetryReplayTx(ctx, tx, snapshot, actor, command)
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

func (s *Service) recoverPoolRetry(ctx context.Context, source poolRecoveryTaskSource, taskID, actor string, command models.PoolRecoveryCommand) (*models.RunEvent, error) {
	identity, previous, err := s.readPoolRecoveryRetry(ctx, taskID, actor, command)
	if err != nil || previous != nil {
		return previous, err
	}
	admission, admitted := s.poolEnqueueAdmission.(poolExecutionQuiescenceAdmission)
	quiescence, supported := s.poolReleaseSource.(poolExecutionQuiescenceSource)
	readiness, ready := s.poolReleaseSource.(PoolRetryReadySource)
	if !admitted || !supported || !ready {
		return nil, models.ErrPoolAdmissionUnavailable
	}
	var event *models.RunEvent
	var committed bool
	err = admission.WithPoolExecutionQuiescence(ctx, identity, func(admitted context.Context) error {
		var err error
		event, committed, err = s.retryPoolRunTx(admitted, source, identity, actor, command, quiescence, readiness)
		return err
	})
	if err != nil {
		return nil, err
	}
	s.notifyPoolRecovery(taskID, event, committed)
	if committed {
		s.signal()
	}
	return event, nil
}
