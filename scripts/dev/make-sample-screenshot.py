import os

from PIL import Image, ImageDraw, ImageFont

W, H = 900, 1180
img = Image.new("RGB", (W, H), (255, 255, 255))
draw = ImageDraw.Draw(img)

font_path = r"C:\Windows\Fonts\msyh.ttc"
title = ImageFont.truetype(font_path, 34)
body = ImageFont.truetype(font_path, 24)
small = ImageFont.truetype(font_path, 20)

lines = [
    ("某科技有限公司", title, (17, 24, 39)),
    ("后端开发工程师（2027届校招）", body, (37, 99, 235)),
    ("", body, (0, 0, 0)),
    ("工作地点：上海 / 杭州", body, (31, 41, 55)),
    ("薪资范围：15k-25k，14薪", body, (31, 41, 55)),
    ("学历要求：本科及以上", body, (31, 41, 55)),
    ("", body, (0, 0, 0)),
    ("【岗位职责】", body, (17, 24, 39)),
    ("1. 参与后端服务的设计与开发，保障系统稳定性；", small, (55, 65, 81)),
    ("2. 负责订单系统的性能优化与容量评估；", small, (55, 65, 81)),
    ("3. 与产品、前端协作完成需求交付。", small, (55, 65, 81)),
    ("", body, (0, 0, 0)),
    ("【技能要求】", body, (17, 24, 39)),
    ("1. 必须精通 Java，熟悉 MySQL 与 Redis；", small, (55, 65, 81)),
    ("2. 具备 Kubernetes 使用经验者优先；", small, (55, 65, 81)),
    ("3. 有深度学习相关项目经验者优先。", small, (55, 65, 81)),
    ("", body, (0, 0, 0)),
    ("【截止时间】2026年11月20日", body, (185, 28, 28)),
]

y = 48
for text, font, color in lines:
    if text:
        draw.text((60, y), text, font=font, fill=color)
    y += 54 if font is title else (44 if font is body else 40)

draw.rectangle([20, 20, W - 20, H - 20], outline=(229, 231, 235), width=2)
draw.line([60, 150, W - 60, 150], fill=(229, 231, 235), width=1)

os.makedirs("data/tmp", exist_ok=True)
out = "data/tmp/psa-jd-screenshot.png"
img.save(out, "PNG")
print(f"已生成截图：{out}（{W}x{H}）")
