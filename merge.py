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


    noise_keywords = [
        'update', '更新', 'history', '历史', 'changelog', '日志', 
        'tgchannel', 'telegram', '频道', '群组', 'author', '作者', 
        'drew', 'by', 'donation', '赞赏', '打赏', 'github', 'repo',
        'version', '版本', 'date', '时间', 'modified', 'crack', '解锁', '删除', '新增', '移除', '修复', '去除', '去掉', '添加', '屏蔽', '处理', '解决'
    ]

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
            # 核心改进：使用深度模拟的 Quantumult X 真实客户端请求头，绕过防盗链重定向
            headers = {
                'User-Agent': 'Quantumult%20X/1.5.0 (iPhone; iOS 18.2; Scale/3.00)',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            }
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as response:
                # 检查是否存在重定向回首页的情况（比如解析到了 HTML 标签）
                content_bytes = response.read()
                content = content_bytes.decode('utf-8').strip()
                
                if not content:
                    raise Exception("下载内容为空")
                
                # 安全阀：如果内容里包含 <html> 或 <script，说明被重定向到了网页首页，判定为下载失败
                if '<html' in content.lower() or '<doctype' in content.lower():
                    raise Exception("被服务器拦截重定向至网页首页")
                
                current_section = 'rewrite'
                sub_rewrite = []
                sub_mitm = []
                
                for raw_line in content.splitlines():
                    l = raw_line.strip()
                    if not l:
                        continue
                    
                    if l.startswith(';') or l.startswith('#'):
                        l_lower = l.lower()
                        if any(kw in l_lower for kw in noise_keywords):
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

    if failed_rules:
        github_output = os.environ.get('GITHUB_OUTPUT')
        if github_output:
            with open(github_output, 'a', encoding='utf-8') as go:
                go.write('failed=true\n')
                go.write('errors=' + ', '.join(failed_rules) + '\n')

if __name__ == '__main__':
    main()
