/**
 * The top of a page: its title, one line on what it is for, and the page's
 * own actions on the right. Styled by .page-header in index.css.
 *
 *   <PageHeader title="Orders" description="…" actions={<button …/>} />
 */
export default function PageHeader({ title, description, actions, children }) {
    return (
        <div className="page-header">
            <div className="page-header-text">
                <h1 className="page-title">{title}</h1>
                {description && <p className="page-desc">{description}</p>}
            </div>
            {actions && <div className="page-actions">{actions}</div>}
            {children}
        </div>
    );
}
