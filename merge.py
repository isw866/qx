import urllib.request
import os
import sys
from datetime import datetime
import re

def clean_and_parse_content(content, noise_keywords, mitm_hosts):
    """
    全量地毯式清洗规则内容，只要包含敏感词的注释行统统抹除，确保防盗链源同样生效
    """
    sub_rewrite = []
    sub_mitm = []
    current_section = 'rewrite' # 默认当作 rewrite 处理
    
    # 彻底统一换行符，并切割成单行列表
    lines = content.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    
    for raw_line in lines:
        stripped_line = raw_line.strip()
        if not stripped_line:
            continue

        # 1. 识别并切换 Quantumult X 的系统标签
        if stripped_line.lower() == '[rewrite_local]':
            current_section = 'rewrite'
            continue
        elif stripped_line.lower() == '[mitm]':
            current_section = 'mitm'
            continue
        elif stripped_line.startswith('[') and stripped_line.endswith(']'):
            current_section = 'unknown'
            continue

        # 2. 核心拦截：如果这一行是纯注释行，直接进行关键词全量匹配
        if stripped_line.startswith(';') or stripped_line.startswith('#'):
            l_lower = stripped_line.lower()
            # 命中你更新的任意一个噪音词，直接丢弃该行
            if any(kw in l_lower for kw in noise_keywords):
                continue
            # 顺手清理掉只包含装饰性符号的干扰行（例如 ; ---------- 或 ; ======）
            if re.match(r'^[;#\s\-\=\*\!\/\.\+\~]+$', stripped_line):
                continue

        # 3. 处理行尾的行内注释 (例如: url reject-img ; 屏蔽某某广告)
        if ';' in raw_line or '#' in raw_line:
            # 用正则精准切开规则体与注释体
            parts = re.split(r'[;#]', raw_line, 1)
            if len(parts) == 2:
                core_part, comment_part = parts[0], parts[1]
                # 如果行尾的注释里包含噪音词，直接把注释切掉，只保留前面的核心规则
                if any(kw in comment_part.lower() for kw in noise_keywords):
                    raw_line = core_part.rstrip()
                    stripped_line = raw_line.strip()
                    if not stripped_line:
                        continue

        # 4. 分流归类有效规则
        if current_section == 'rewrite':
            sub_rewrite.append(raw_line)
        elif current_section == 'mitm':
            if 'hostname' in stripped_line:
                try:
                    _, hosts = stripped_line.split('=', 1)
                    for h in hosts.split(','):
                        h_clean = h.strip()
                        # 确保提取出的 hostname 不带任何干扰符号和残余注释
                        if h_clean and not h_clean.startswith(';') and not h_clean.startswith('#'):
                            # 进一步清洗 hostname 行尾可能夹带的注释
                            h_clean = re.split(r'[;#]', h_clean)[0].strip()
                            mitm_hosts.add(h_clean)
                except Exception:
                    sub_mitm.append(raw_line)
            else:
                sub_mitm.append(raw_line)
                
    return sub_rewrite, sub_mitm

def main():
    list_file = 'rules_list.txt'
    output_file = 'myRewrite.conf'
    
    if not os.path.exists(list_file):
        print(f"错误：未找到 {list_file} 文件！")
        sys.exit(1)

    failed_rules = []
    rewrite_lines = []
    mitm_hosts = set()

    # 你更新后的强力噪音拦截词库
    noise_keywords = [
        'update', '更新', 'history', '历史', 'changelog', '日志', 
        'tgchannel', 'telegram', '频道', '群组', 'author', '作者', 
        'drew', 'by', 'donation', '赞赏', '打赏', 'github', 'repo',
        'version', '版本', 'date', '时间', 'modified', 'crack', '解锁', 
        '删除', '新增', '移除', '修复', '去除', '去掉', '添加', '屏蔽', 
        '处理', '解决', '墨鱼', 't.me'
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
            headers = {
                'User-Agent': 'Quantumult%20X/1.5.0 (iPhone; iOS 18.2; Scale/3.00)',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            }
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as response:
                content = response.read().decode('utf-8').strip()
                
                if not content:
                    raise Exception("下载内容为空")
                
                if '<html' in content.lower() or '<doctype' in content.lower():
                    raise Exception("被服务器拦截重定向至网页首页")
                
                # 调用深度清洗
                sub_rewrite, sub_mitm = clean_and_parse_content(content, noise_keywords, mitm_hosts)

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
