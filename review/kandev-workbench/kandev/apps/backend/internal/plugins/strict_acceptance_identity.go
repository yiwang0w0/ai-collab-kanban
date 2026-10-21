package plugins

func (s *Service) SetStrictCompletionVerifierID(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.strictCompletionVerifierID = id
}
func (s *Service) requiresRealAcceptanceActor(installationID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return installationID != "" && s.strictCompletionVerifierID == "plugin:"+installationID
}
