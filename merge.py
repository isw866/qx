import urllib.request
import os
import sys
from datetime import datetime
import re

def clean_and_parse_content(content, noise_keywords, name, mitm_hosts):
    """
    深度清洗单个规则文件，剔除更新日志、赞赏码等无关注释，并提取有效规则
    """
    sub_rewrite = []
    sub_mitm = []
    current_section = 'rewrite' # 默认当作 rewrite 处理
    
    # 预处理：去掉 Windows 换行符的干扰
    lines = content.replace('\r\n', '\n').split('\n')
    
    # 状态机标记：用来跳过开头的连续垃圾注释块
    in_head_garbage = True 

    for raw_line in lines:
        stripped_line = raw_line.strip()
        if not stripped_line:
            continue

        # 1. 识别标签切换状态
        if stripped_line.lower() == '[rewrite_local]':
            current_section = 'rewrite'
            in_head_garbage = False # 遇到了标准标签，停止头部垃圾检查
            continue
        elif stripped_line.lower() == '[mitm]':
            current_section = 'mitm'
            in_head_garbage = False
            continue
        elif stripped_line.startswith('[') and stripped_line.endswith(']'):
            current_section = 'unknown'
            in_head_garbage = False
            continue

        # 2. 智能过滤头部大块垃圾注释
        if in_head_garbage and (stripped_line.startswith(';') or stripped_line.startswith('#')):
            # 如果开头的注释包含了垃圾关键词，直接跳过整个注释行
            if any(kw in stripped_line.lower() for kw in noise_keywords):
                continue
            # 即使没包含关键字，如果是一些装饰性的符号（如 ; ------ 或 ; =====），也顺手清理掉
            if re.match(r'^[;#\s\-\=\*\!\/\.\+\~]+$', stripped_line):
                continue

        # 一旦遇到了非注释行，说明正式进入核心规则区，关闭头部垃圾过滤器
        if not (stripped_line.startswith(';') or stripped_line.startswith('#')):
            in_head_garbage = False

        # 3. 处理行尾的行内注释 (例如: url reject-img ; 过滤某个广告)
        # 如果注释里带有垃圾词，把注释部分切掉，只保留前面的核心规则
        if ';' in raw_line or '#' in raw_line:
            # 区分是真正的注释，还是 URL 里的分号（QuanX 规则里分号一般只用于注释）
            parts = re.split(r'[;#]', raw_line, 1)
            if len(parts) == 2:
                core_part, comment_part = parts[0], parts[1]
                if any(kw in comment_part.lower() for kw in noise_keywords):
                    # 如果行尾注释包含垃圾词，抛弃注释，只留核心代码
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
                        if h_clean and not h_clean.startswith(';'):
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

    # 针对墨鱼等规则深度定制的噪音拦截词库
    
    noise_keywords = [
        'update', '更新', 'history', '历史', 'changelog', '日志', 
        'tgchannel', 'telegram', '频道', '群组', 'author', '作者', 
        'drew', 'by', 'donation', '赞赏', '打赏', 'github', 'repo',
        'version', '版本', 'date', '时间', 'modified', 'crack', '解锁', '删除', '新增', '移除', '修复', '去除', '去掉', '添加', '屏蔽', '处理', '解决', '墨鱼', 't.me'
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
                
                # 调用深度清洗函数
                sub_rewrite, sub_mitm = clean_and_parse_content(content, noise_keywords, name, mitm_hosts)

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
