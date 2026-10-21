package main

import "time"

const criterionID = "fleet.acceptance"

type settings struct {
	NodePath              string `json:"node_path"`
	CheckerPath           string `json:"checker_path"`
	RepositoryID          string `json:"repository_id"`
	RepositoryRoot        string `json:"repository_root"`
	AcceptanceStepID      string `json:"acceptance_step_id"`
	ImplementationAgentID string `json:"implementation_agent_id"`
	ReviewAgentID         string `json:"review_agent_id"`
}

type deliveryTask struct {
	Result    string `json:"result"`
	WorkSpans string `json:"work_spans"`
}
type deliveryInput struct {
	Format     string         `json:"format"`
	RepoRoot   string         `json:"repo_root"`
	HeadBranch string         `json:"head_branch"`
	Task       deliveryTask   `json:"task"`
	Expected   *deliveryCheck `json:"expected,omitempty"`
}
type artifact struct {
	Path   string  `json:"path"`
	SHA256 *string `json:"sha256"`
}
type violation struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type deliveryCheck struct {
	Format       string      `json:"format"`
	Status       string      `json:"status"`
	Head         string      `json:"head"`
	Fingerprint  string      `json:"fingerprint"`
	RulesVersion string      `json:"rules_version"`
	Artifacts    []artifact  `json:"artifacts"`
	Violations   []violation `json:"violations"`
}
type candidate struct {
	Format                        string        `json:"format"`
	ID                            string        `json:"id"`
	State                         string        `json:"state"`
	TaskID                        string        `json:"task_id"`
	TaskResourceVersion           string        `json:"task_resource_version"`
	RepositoryID                  string        `json:"repository_id"`
	HeadBranch                    string        `json:"head_branch"`
	ImplementationSessionID       string        `json:"implementation_session_id"`
	ReviewSessionID               string        `json:"review_session_id"`
	ImplementationResourceVersion string        `json:"implementation_resource_version"`
	ReviewResourceVersion         string        `json:"review_resource_version"`
	Task                          deliveryTask  `json:"task"`
	Check                         deliveryCheck `json:"check"`
	GateRevision                  int64         `json:"gate_revision"`
	SubmittedBy                   string        `json:"submitted_by"`
	SubmittedAt                   time.Time     `json:"submitted_at"`
	ActorID                       string        `json:"actor_id,omitempty"`
	AcceptedAt                    time.Time     `json:"accepted_at,omitempty"`
	Reason                        string        `json:"reason,omitempty"`
}
