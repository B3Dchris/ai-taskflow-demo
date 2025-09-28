# Definition of Done (DoD) - TaskFlow API

A feature is **Done** when all the following criteria are met:

## 1. Planning ✅
- [ ] Capability defined in capability_map.json
- [ ] Interface signature documented in interfaces.md
- [ ] Data flow contracts defined in dataflow.json
- [ ] Acceptance criteria linked to BRD requirements

## 2. Testing ✅
- [ ] Unit tests written for happy path
- [ ] Unit tests written for at least 2 edge cases
- [ ] Unit tests written for at least 1 negative case
- [ ] Integration tests written if cross-module dependencies exist
- [ ] All tests pass locally
- [ ] Test coverage meets minimum thresholds (85% lines, 70% branches)

## 3. Implementation ✅
- [ ] Code implements the exact interface signature
- [ ] Code follows Python PEP 8 style guidelines
- [ ] Code includes proper error handling
- [ ] Code includes input validation where required
- [ ] No hardcoded secrets or configuration
- [ ] Logging added for debugging and monitoring

## 4. Quality Gates ✅
- [ ] Code formatted with black
- [ ] Code passes flake8 linting
- [ ] Type hints added and mypy passes
- [ ] Security scan passes (no critical/high vulnerabilities)
- [ ] Performance requirements met (< 200ms response time)

## 5. Documentation ✅
- [ ] Docstrings added to all public functions/classes
- [ ] API documentation updated (if applicable)
- [ ] README updated with new functionality
- [ ] ADR created if architectural decisions made

## 6. Integration ✅
- [ ] Code integrates with existing modules without breaking changes
- [ ] Database migrations created (if schema changes)
- [ ] Environment configuration updated (if needed)
- [ ] Dependencies added to requirements.txt

## 7. Traceability ✅
- [ ] Acceptance criteria mapped to test cases
- [ ] Test cases linked to implementation
- [ ] Commit messages follow conventional format
- [ ] Traceability.csv updated with AC_ID, tests, commits

## 8. Review ✅
- [ ] Code review completed by another agent/human
- [ ] Security review completed for auth-related changes
- [ ] Performance review completed for data-intensive operations
- [ ] All review comments addressed

## 9. Deployment Ready ✅
- [ ] Feature works in local development environment
- [ ] Feature works with production-like data volumes
- [ ] Rollback plan documented
- [ ] Monitoring/alerting configured

## 10. Acceptance ✅
- [ ] All acceptance criteria from BRD verified
- [ ] Stakeholder approval obtained
- [ ] Feature demonstrated working end-to-end
- [ ] User documentation updated

---

## Quality Thresholds

### Code Coverage
- **Minimum:** 85% line coverage, 70% branch coverage
- **Target:** 90% line coverage, 80% branch coverage

### Performance
- **API Response Time:** < 200ms for 95% of requests
- **Database Query Time:** < 50ms for simple queries
- **Memory Usage:** < 128MB per process

### Security
- **Vulnerability Scan:** No critical or high severity issues
- **Authentication:** All protected endpoints require valid JWT
- **Input Validation:** All user inputs validated and sanitized

### Documentation
- **API Coverage:** 100% of public endpoints documented
- **Code Documentation:** All public functions have docstrings
- **Architecture:** All major decisions recorded in ADRs

---

## Escalation Criteria

If any DoD criteria cannot be met, escalate to:
1. **Technical Issues:** Tech Lead (Cascade AI Agent)
2. **Requirements Issues:** Product Owner (AI Development Team)  
3. **Quality Issues:** QA Agent
4. **Security Issues:** Security Review Process

---

## Exceptions

Exceptions to DoD criteria must be:
1. Documented with justification
2. Approved by Tech Lead
3. Include remediation plan with timeline
4. Tracked in risk register
