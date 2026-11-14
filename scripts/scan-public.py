"""Report only file/line/category; never print matching values."""
from pathlib import Path
import re
root=Path(__file__).resolve().parent.parent
rules={
 'private-key':r'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----',
 'token-pattern':r'(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})',
 'credential-literal':r'''(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"][^'"\s]{12,}['"]''',
 'developer-path':r'(?i)(?<![A-Za-z0-9])(?:[D-Z]:[\\/]|[A-Z]:\\\\Users\\\\[^\\]+|/Users/[^/]+/|/home/[^/]+/)'
}
findings=[]
for file in sorted(root.rglob('*')):
 if not file.is_file() or any(p in ('node_modules','.git','dist','external-resources') for p in file.relative_to(root).parts):continue
 if file.suffix.lower() not in ('.js','.cjs','.json','.html','.css','.md','.toml','.yml','.yaml','.txt','.py') and file.name not in ('NOTICE','.gitignore'):continue
 if file.name=='scan-public.py':continue
 for line_no,line in enumerate(file.read_text('utf-8',errors='replace').splitlines(),1):
  for category,pattern in rules.items():
   if re.search(pattern,line):findings.append((file.relative_to(root).as_posix(),line_no,category))
for file,line,category in findings:print(f'{file}:{line}: {category}')
print(f'Scan completed: {len(findings)} finding(s). Values are never included.')
raise SystemExit(1 if findings else 0)
