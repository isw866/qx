import urllib.request
import os
import sys
from datetime import datetime

def main():
    list_file = 'rules_list.txt'
    output_file = 'myRewrite.conf'
    
    if not os.path.exists(list_file):
        print(f"错误：未找到 {list_file} 文件！")
        sys.exit(1)

    failed_rules = []
    rewrite_lines = []
    mitm_hosts = set()

    with open(list_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    for line in lines:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        
        try:
            name, url = line.split(',', 1)
            name = name.strip()
            url = url.strip()
        except ValueError:
            print(f"跳过格式错误的行: {line}")
            continue

        print(f"正在下载 [{name}]: {url}")
        
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 QuantumultX'})
            with urllib.request.urlopen(req, timeout=15) as response:
                content = response.read().decode('utf-8').strip()
                
                if not content:
                    raise Exception("下载内容为空")
                
                current_section = 'rewrite'
                sub_rewrite = []
                sub_mitm = []
                
                for raw_line in content.splitlines():
                    l = raw_line.strip()
                    if not l:
                        continue
                    
                    if l.lower() == '[rewrite_local]':
                        current_section = 'rewrite'
                        continue
                    elif l.lower() == '[mitm]':
                        current_section = 'mitm'
                        continue
                    elif l.startswith('[') and l.endswith(']'):
                        current_section = 'unknown'
                        continue
                    
                    if current_section == 'rewrite':
                        sub_rewrite.append(raw_line)
                    elif current_section == 'mitm':
                        if 'hostname' in l:
                            try:
                                _, hosts = l.split('=', 1)
                                for h in hosts.split(','):
                                    h_clean = h.strip()
                                    if h_clean:
                                        mitm_hosts.add(h_clean)
                            except Exception:
                                sub_mitm.append(raw_line)
                        else:
                            sub_mitm.append(raw_line)

                if sub_rewrite or sub_mitm:
                    rewrite_lines.append(f"; === 开始: {name} ===")
                    if sub_rewrite:
                        rewrite_lines.extend(sub_rewrite)
                    if sub_mitm:
                        rewrite_lines.extend(sub_mitm)
                    rewrite_lines.append(f"; === 结束: {name} ===\n")
                
        except Exception as e:
            print(f"❌ 规则 [{name}] 下载失败: {str(e)}")
            failed_rules.append(f"{name} ({str(e)})")

    # 组装最终符合规范的 conf 文件
    final_content = [
        '; Quantumult X 重写规则集合',
        '; 自动更新于: ' + datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        '; --------------------------------------------------\n',
        '[rewrite_local]'
    ]
    
    final_content.extend(rewrite_lines)
    
    if mitm_hosts:
        final_content.append('[mitm]')
        final_content.append('hostname = ' + ', '.join(sorted(list(mitm_hosts))))

    if rewrite_lines: 
        with open(output_file, 'w', encoding='utf-8') as out:
            out.write('\n'.join(final_content))

    # 如果有失败的，写入 GitHub Actions 的环境输出
    if failed_rules:
        github_output = os.environ.get('GITHUB_OUTPUT')
        if github_output:
            with open(github_output, 'a', encoding='utf-8') as go:
                go.write('failed=true\n')
                go.write('errors=' + ', '.join(failed_rules) + '\n')

if __name__ == '__main__':
    main()
