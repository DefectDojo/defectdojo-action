# DefectDojo

The official GitHub Action for [DefectDojo](https://defectdojo.com). It imports a scan report into DefectDojo Pro or Community Edition, records which build, branch and commit it came from, and can fail the step on the severities you choose.

It reads every report format DefectDojo supports, including SARIF, so it works after almost any scanner.

```yaml
permissions:
  contents: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Scan
        uses: aquasecurity/trivy-action@v0.36.0
        with:
          scan-type: fs
          format: json
          output: trivy.json
      - name: Import into DefectDojo
        uses: DefectDojo/defectdojo-action@v1
        with:
          defectdojo-url: https://defectdojo.example.com
          api-token: ${{ secrets.DEFECTDOJO_API_TOKEN }}
          file: trivy.json
          scan-type: Trivy Scan
          fail-on: critical
```

By default the product is named after the repository, its product type after the repository owner, and the engagement after the branch. Each run reimports into the same test, so findings the scanner no longer reports are closed and the history of each finding is kept. Product, product type and engagement are created the first time they're needed.

## DefectDojo Pro and Community Edition

The action works with both editions. It asks the instance which edition it is once per run.

| | Community Edition | Pro |
| --- | --- | --- |
| Import and reimport any supported report | Yes | Yes |
| Auto-create product type, product and engagement | Yes | Yes |
| Build, branch, commit and repository on every test | Yes | Yes |
| Fail the step at a severity | Yes | Yes |
| Job summary with counts and a link to the test | Yes | Yes |
| Asset and Organization names (`asset-name`, `organization-name`) | Yes | Yes |
| Push new findings to connected tools (`push-to-connector`) | No | Yes |
| Background import for large reports (`background-import`) | No | Yes |
| Warnings when a product was renamed or moved | No | Yes |
| Sensei fixes for imported findings | No | Yes |

When a Pro-only input is set on Community Edition, the action logs a warning, skips that input and finishes the import. Set `strict: true` to fail instead. [Compare editions](https://defectdojo.com/pricing?utm_source=github&utm_medium=action&utm_campaign=defectdojo-action&utm_content=readme).

## Examples

### Several reports in one job

Give each report its own `test-title` when they share a scan type, so each reimport finds its own test.

```yaml
      - uses: DefectDojo/defectdojo-action@v1
        with:
          defectdojo-url: ${{ vars.DEFECTDOJO_URL }}
          api-token: ${{ secrets.DEFECTDOJO_API_TOKEN }}
          file: semgrep.sarif
          scan-type: SARIF
          test-title: Semgrep
      - uses: DefectDojo/defectdojo-action@v1
        with:
          defectdojo-url: ${{ vars.DEFECTDOJO_URL }}
          api-token: ${{ secrets.DEFECTDOJO_API_TOKEN }}
          file: gitleaks.sarif
          scan-type: SARIF
          test-title: Gitleaks
```

### Pro: Assets, Organizations and connectors

```yaml
      - uses: DefectDojo/defectdojo-action@v1
        with:
          defectdojo-url: https://acme.cloud.defectdojo.com
          api-token: ${{ secrets.DEFECTDOJO_API_TOKEN }}
          file: results.sarif
          scan-type: SARIF
          asset-name: Payments API
          organization-name: Fintech
          push-to-connector: true
          background-import: true
```

### Use the outputs

```yaml
      - id: dojo
        uses: DefectDojo/defectdojo-action@v1
        with:
          defectdojo-url: ${{ vars.DEFECTDOJO_URL }}
          api-token: ${{ secrets.DEFECTDOJO_API_TOKEN }}
          file: results.sarif
          scan-type: SARIF
      - run: echo "${{ steps.dojo.outputs.active-critical }} critical findings, see ${{ steps.dojo.outputs.test-url }}"
```

## Inputs

**Required**

| Input | Description |
| --- | --- |
| `defectdojo-url` | Address of your DefectDojo instance, for example `https://defectdojo.example.com`. |
| `api-token` | DefectDojo API v2 key. Pass it from a secret. |
| `file` | Path to the report to import. |
| `scan-type` | DefectDojo scan type of the report, for example `SARIF`, `Trivy Scan` or `Semgrep JSON Report`. The names are on the [supported tools](https://docs.defectdojo.com/supported_tools/) page. |

**Where the findings go**

| Input | Description | Default |
| --- | --- | --- |
| `product-name` or `asset-name` | Product (Pro: Asset) to import into. | Repository name |
| `product-type-name` or `organization-name` | Product type (Pro: Organization) of the product. | Repository owner |
| `engagement-name` | Engagement to import into. | Branch name |
| `test-title` | Title of the test. Give each report its own title when one engagement gets several reports of the same scan type. | Scan type |
| `auto-create-context` | Create the product type, product and engagement if they don't exist. | `true` |
| `environment` | Environment, for example `Development` or `Production`. | |
| `service` | Service the report covers. Deduplication and closing old findings are scoped to it. | |

**How it imports**

| Input | Description | Default |
| --- | --- | --- |
| `reimport` | Update the matching test instead of adding a new one each run. | `true` |
| `close-old-findings` | Close findings that are no longer in the report. | DefectDojo's: true for reimport, false for import |
| `close-old-findings-product-scope` | With `reimport: false`, close old findings across the whole product, not just the engagement. | |
| `do-not-reactivate` | With reimport, leave findings closed in DefectDojo closed even if the report still has them. | |
| `minimum-severity` | Skip findings below this severity. | `Info` |
| `active` | Force imported findings active or inactive. Unset keeps the scanner's own value. | |
| `verified` | Force imported findings verified or unverified. Unset keeps the scanner's own value. | |
| `tags` | Tags for the test, separated by commas or new lines. | |
| `apply-tags-to-findings` | Also add the tags to every imported finding. | |
| `group-by` | Group new findings by `component_name`, `component_name+component_version`, `file_path`, `finding_title` or `vuln_id_from_tool`. | |
| `deduplication-on-engagement` | Deduplicate within the engagement instead of across the product. | |
| `push-to-jira` | Push new findings to Jira, if the product has a Jira configuration. | |
| `timeout-minutes` | How long to wait for the import, including background processing on Pro. | `30` |

**Build metadata**, filled in from the workflow run unless you set them

| Input | Default |
| --- | --- |
| `build-id` | Workflow run ID |
| `branch-tag` | Branch, or the pull request's source branch |
| `commit-hash` | Commit, or the pull request's head commit |
| `source-code-management-uri` | Repository URL |
| `version` | |

**Gate**

| Input | Description | Default |
| --- | --- | --- |
| `fail-on` | Fail the step when the test has active findings at this severity or above: `info`, `low`, `medium`, `high`, `critical` or `none`. Duplicates don't count. | `none` |

**Pro**

| Input | Description | Default |
| --- | --- | --- |
| `push-to-connector` | Push new findings to the connected tools set up for the product. | |
| `background-import` | Parse the report, then create findings in the background. The action waits for the test to finish processing. | |
| `strict` | Fail instead of warning when a Pro-only input is set on Community Edition. | `false` |

## Outputs

| Output | Description |
| --- | --- |
| `edition` | `pro`, `community` or `unknown` |
| `test-id`, `test-url` | The test the report went into |
| `engagement-id`, `product-id` | Its engagement and product |
| `active` | Active findings in the test after the import |
| `active-critical`, `active-high`, `active-medium`, `active-low`, `active-info` | The same, by severity |
| `created`, `closed`, `reactivated` | What this run changed, when DefectDojo reports it |

## Notes

**API key.** Create a key for a user that can import into the product (and create it, with `auto-create-context`). Store it as a repository or organization secret. The action masks it in the log.

**Pull requests from forks.** GitHub doesn't give secrets to workflows that run on pull requests from forks, so the import can't authenticate there. Run the import on `push`, or on pull requests from branches in the same repository. Don't use `pull_request_target` to get around this: it runs with your secrets while checking out code you don't control.

**Private certificate authorities and proxies.** If the instance's certificate comes from a private certificate authority, set `NODE_EXTRA_CA_CERTS` on the step to the path of its certificate. To go through a proxy, set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1`.

**Counts and deduplication.** The action asks DefectDojo to finish deduplication before it answers, so the counts and the gate see the final state. Releases before 3.1.0 don't support that and answer straight away, in which case the summary says the counts may include findings later marked as duplicates.

## Privacy

The action sends the report, and the names and build details above, only to the `defectdojo-url` you give it. It has no telemetry or analytics, and it sends nothing to DefectDojo, Inc. unless your instance is hosted by DefectDojo. It writes the counts and a link to the test to the job summary and the step outputs in your own repository.

DefectDojo's privacy policy is at [defectdojo.com/privacy-policy](https://defectdojo.com/privacy-policy).

## License

BSD 3-Clause. See [LICENSE](LICENSE).

Report security issues as described in [SECURITY.md](SECURITY.md).
