package sqlite

// 关系只计同工作区的原生可见主卡；缺失、已归档或异域前置仍保留为阻塞。
const poolProjectionContextSQL = `SELECT t.id AS task_id,
	COALESCE(parent.id,'') AS parent_id,
	(SELECT COUNT(*) FROM tasks child WHERE child.parent_id=t.id AND child.workspace_id=t.workspace_id
		AND child.archived_at IS NULL AND child.is_ephemeral=0) AS child_count,
	(SELECT COUNT(*) FROM task_blockers edge JOIN tasks target ON target.id=edge.blocker_task_id
		AND target.workspace_id=t.workspace_id AND target.archived_at IS NULL AND target.is_ephemeral=0
		WHERE edge.task_id=t.id) AS depends_on_count,
	(SELECT COUNT(*) FROM task_blockers edge JOIN tasks target ON target.id=edge.task_id
		AND target.workspace_id=t.workspace_id AND target.archived_at IS NULL AND target.is_ephemeral=0
		WHERE edge.blocker_task_id=t.id) AS blocks_count,
	EXISTS (SELECT 1 FROM task_blockers edge LEFT JOIN tasks target ON target.id=edge.blocker_task_id
		WHERE edge.task_id=t.id AND (target.id IS NULL OR target.workspace_id<>t.workspace_id
		OR target.archived_at IS NOT NULL OR target.state<>?)) AS dependencies_blocked,
	t.wip_admitted,COALESCE(t.queued_for_step_id,'')<>'' AS queued_for_step,
	COALESCE(s.id,'') AS step_id,s.updated_at AS step_updated_at,COALESCE(s.agent_profile_id,'') AS step_profile_id,
	CASE WHEN length(CAST(COALESCE(s.events,'') AS BLOB))<=16384
		THEN COALESCE(s.events,'') ELSE 'unmeasurable' END AS step_events,
	s.session_target,COALESCE(s.complete_task_on_enter,0) AS complete_task_on_enter,
	COALESCE(p.id,'') AS profile_id,COALESCE(p.agent_id,'') AS profile_agent_id,
	COALESCE(a.id,'') AS agent_id,COALESCE(a.name,'') AS agent_family,
	COALESCE(p.workspace_id,'') AS profile_workspace_id,COALESCE(a.workspace_id,'') AS agent_workspace_id,
	COALESCE(p.enabled,0) AS enabled,p.deleted_at IS NOT NULL AS deleted,
	COALESCE(p.provider_kind,'') AS provider_kind,COALESCE(p.auto_fallback,1) AS auto_fallback,
	COALESCE(p.fallback_model,'') AS fallback_model,COALESCE(p.cli_passthrough,0) AS cli_passthrough,
	COALESCE(p.execution_agent_profile_id,'') AS execution_agent_profile_id,
	CASE WHEN length(CAST(COALESCE(a.tui_config,'') AS BLOB))<=16384
		THEN COALESCE(a.tui_config,'') ELSE 'unmeasurable' END AS tui_config
	FROM tasks t LEFT JOIN tasks parent ON parent.id=t.parent_id AND parent.workspace_id=t.workspace_id
		AND parent.archived_at IS NULL AND parent.is_ephemeral=0
	LEFT JOIN workflows w ON w.id=t.workflow_id AND w.workspace_id=t.workspace_id
	LEFT JOIN workflow_steps s ON s.id=t.workflow_step_id AND s.workflow_id=w.id
	LEFT JOIN agent_profiles p ON p.id=s.agent_profile_id LEFT JOIN agents a ON a.id=p.agent_id
	WHERE t.id IN (?) AND t.workspace_id=?`
